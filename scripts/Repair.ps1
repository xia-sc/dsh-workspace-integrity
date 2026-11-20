param(
    [ValidateSet('scan', 'fix', 'verify', 'rollback', 'records')]
    [string]$Action = 'scan',

    [string]$Path,

    [string]$BackupDir,

    [string]$BackupRoot,

    [switch]$RemoveAces,

    [switch]$AllFiles,

    [switch]$Fast,

    [ValidateSet('auto', 'manual', 'tool')]
    [string]$Trigger = 'manual',

    [switch]$Json,

    [ValidateRange(1, 2147483647)]
    [int]$MaxObjects = 20000,

    # 目录排除清单：不含反斜杠的条目按目录名匹配任意层级，含反斜杠的条目按
    # 相对根的路径前缀匹配。默认排除版本库元数据目录，避免 .git 等子树
    # 淹没命中并触发 MaxObjects 截断。根目录自身不受排除影响。
    [string[]]$ExcludeDirs = @('.git', '.hg', '.svn'),

    # 显式允许操作本脚本判定为危险的目标（盘根、SystemRoot、Program Files、
    # ProgramData、用户目录根）。
    [switch]$AllowDangerousRoot,

    # 只输出修复计划，不写回滚记录、不修改任何 ACL。
    [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch { }

# The DSH Windows ACL sandbox's grant shape (see
# @deepseek-ai/dsh-sandbox-windows-acl): FILE_GENERIC_WRITE | DELETE |
# FILE_DELETE_CHILD minus STANDARD_RIGHTS_WRITE, on a per-workspace
# S-1-4-x-y (or per-temp S-1-4-x-y-1) capability SID, inherited OI|CI. The
# ambient-delete deny is FILE_DELETE_CHILD for Everyone, inherited CI only.
$script:GrantMask = 0x00110156
$script:ContainerInherit = 0x2
$script:SubContainersAndObjects = 0x3

function Invoke-Icacls([string[]]$IcaclsArgs) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & icacls @IcaclsArgs 2>&1
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    return [pscustomobject]@{ code = $code; text = ($out | Out-String) }
}

function Set-LabelTree([string]$root, [string]$flags = '(OI)(CI)M') {
    # icacls 对文件会忽略 (OI)(CI) 继承标志：带该标志时文件标签不变，但命令
    # 仍可能返回成功；/C 又会让单对象失败不影响退出码。因此不能先用退出码
    # 判断，必须始终按 WRITE_DAC 临时授予完全控制，执行两遍后按保存的 SDDL
    # 还原。还原放在 finally 中，重试抛异常也不会留下临时授权。
    $level = $flags
    if ($level -match '^\(OI\)\(CI\)(.+)$') { $level = $Matches[1] }
    $inheritFlags = '(OI)(CI)' + $level
    $sddl = $null
    $err = $null
    $saveRc = [Wi]::SaveSddl((ConvertTo-LongPath $root), [ref]$sddl, [ref]$err)
    if ($saveRc -ne 0 -or -not $sddl) {
        return [pscustomobject]@{ ok = $false; text = ''; fallback = $false; restoreError = "could not save the root DACL: $err" }
    }

    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $restoreError = $null
    $grant = $null
    $pass1 = $null
    $pass2 = $null
    try {
        $grant = Invoke-Icacls @($root, '/grant', ($user + ':(OI)(CI)(F)'), '/C', '/Q')
        $pass1 = Invoke-Icacls @($root, '/setintegritylevel', $level, '/T', '/C', '/Q')
        $pass2 = Invoke-Icacls @($root, '/setintegritylevel', $inheritFlags, '/T', '/C', '/Q')
    } finally {
        $restoreErr = $null
        $restoreRc = [Wi]::RestoreSddl((ConvertTo-LongPath $root), [string]$sddl, [ref]$restoreErr)
        if ($restoreRc -ne 0) { $restoreError = "DACL restore failed: $restoreErr" }
    }
    $grantCode = if ($null -ne $grant) { $grant.code } else { 1 }
    $code1 = if ($null -ne $pass1) { $pass1.code } else { 1 }
    $code2 = if ($null -ne $pass2) { $pass2.code } else { 1 }
    $text = ($(if ($null -ne $grant) { $grant.text } else { '' }) + "`n" + $(if ($null -ne $pass1) { $pass1.text } else { '' }) + "`n" + $(if ($null -ne $pass2) { $pass2.text } else { '' }))
    return [pscustomobject]@{
        ok = ($grantCode -eq 0 -and $code1 -eq 0 -and $code2 -eq 0 -and -not $restoreError)
        text = $text
        fallback = $true
        restoreError = $restoreError
    }
}

function ConvertTo-LongPath([string]$p) {
    if ($p.StartsWith('\\?\')) { return $p }
    if ($p.StartsWith('\\')) { return '\\?\UNC\' + $p.Substring(2) }
    return '\\?\' + $p
}

function ConvertFrom-LongPath([string]$p) {
    if ($p.StartsWith('\\?\UNC\')) { return '\\' + $p.Substring(8) }
    if ($p.StartsWith('\\?\')) { return $p.Substring(4) }
    return $p
}

function Get-PathHash([string]$p) {
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($p.ToLowerInvariant()))
    } finally {
        $sha.Dispose()
    }
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').Substring(0, 16)
}

function Test-Reparse([string]$p) {
    try {
        $attr = [System.IO.File]::GetAttributes($p)
        return (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    } catch { return $true }
}

function Get-NormalizedKey([string]$p) {
    try { return [System.IO.Path]::GetFullPath($p).TrimEnd('\').ToLowerInvariant() }
    catch { return $p.TrimEnd('\').ToLowerInvariant() }
}

# Returns a description of the dangerous root this path is, or $null.
function Test-DangerousRoot([string]$root) {
    $full = [System.IO.Path]::GetFullPath($root)
    if ($full -match '^[A-Za-z]:\\?$') { return 'a drive root' }

    $folders = @()
    foreach ($name in @('SystemRoot', 'ProgramFiles', 'ProgramData')) {
        $dir = [Environment]::GetEnvironmentVariable($name)
        if ($dir) { $folders += $dir }
    }
    $x86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($x86) { $folders += $x86 }
    foreach ($dir in $folders) {
        $key = Get-NormalizedKey $dir
        $rootKey = Get-NormalizedKey $full
        if ($rootKey -eq $key -or $rootKey.StartsWith($key + '\')) { return $dir }
    }

    $profileDir = [Environment]::GetFolderPath('UserProfile')
    if ($profileDir -and (Get-NormalizedKey $full) -eq (Get-NormalizedKey $profileDir)) { return 'the user profile root' }
    $usersRoot = Join-Path $env:SystemDrive 'Users'
    if ((Get-NormalizedKey $full) -eq (Get-NormalizedKey $usersRoot)) { return 'the Users root' }
    return $null
}

# A lock that protects direct script runs. The plugin holds its own lock, so
# this uses a separate namespace: two independent callers of Repair.ps1 (or a
# direct run racing the plugin) still serialize.
function Enter-PathLock([string]$root) {
    $lockDir = Join-Path $env:TEMP 'dsh-workspace-integrity-locks'
    if (-not (Test-Path -LiteralPath $lockDir)) { New-Item -ItemType Directory -Path $lockDir -Force | Out-Null }
    $file = Join-Path $lockDir ((Get-PathHash $root) + '.lock')
    for ($attempt = 0; $attempt -lt 2; $attempt++) {
        try {
            $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            return [pscustomobject]@{ File = $file; Stream = $stream }
        } catch [System.IO.IOException] {
            try {
                $age = (Get-Date) - (Get-Item -LiteralPath $file).LastWriteTime
                if ($age.TotalMinutes -gt 10) { Remove-Item -LiteralPath $file -Force; continue }
            } catch { continue }
            throw "Another repair is already running for $root (lock: $file)."
        }
    }
    throw "Could not acquire the repair lock for $root."
}

function Exit-PathLock($lock) {
    if ($null -eq $lock) { return }
    try { $lock.Stream.Dispose() } catch { }
    try { Remove-Item -LiteralPath $lock.File -Force } catch { }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Wi
{
    const int SE_FILE_OBJECT = 1;
    const uint OWNER_SECURITY_INFORMATION = 0x1;
    const uint DACL_SECURITY_INFORMATION = 0x4;
    const uint LABEL_SECURITY_INFORMATION = 0x10;
    const int ACL_SIZE_INFORMATION_CLASS = 2;
    const uint INHERITED_ACE = 0x10;
    const uint FILE_DELETE_CHILD = 0x40;
    // DSH sandbox grant/deny shapes.
    const uint GRANT_MASK = 0x00110156;
    const uint CONTAINER_INHERIT_ACE = 0x2;
    const uint SUB_CONTAINERS_AND_OBJECTS_INHERIT = 0x3;
    const uint MAX_SUB_AUTHORITY_30 = 0x3FFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    struct ACL_SIZE_INFORMATION
    {
        public uint AceCount;
        public uint AclBytesInUse;
        public uint AclBytesFree;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct ACE_HEADER
    {
        public byte AceType;
        public byte AceFlags;
        public ushort AceSize;
    }

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint GetNamedSecurityInfoW(
        string pObjectName, int ObjectType, uint SecurityInfo,
        out IntPtr ppsidOwner, out IntPtr ppsidGroup,
        out IntPtr ppDacl, out IntPtr ppSacl, out IntPtr ppSecurityDescriptor);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern uint SetNamedSecurityInfoW(
        string pObjectName, int ObjectType, uint SecurityInfo,
        IntPtr psidOwner, IntPtr psidGroup, IntPtr pDacl, IntPtr pSacl);

    [DllImport("advapi32.dll")]
    static extern bool GetAclInformation(IntPtr pAcl, out ACL_SIZE_INFORMATION pAclInformation, uint nAclInformationLength, int dwAclInformationClass);

    [DllImport("advapi32.dll")]
    static extern bool GetAce(IntPtr pAcl, uint dwAceIndex, out IntPtr pAce);

    [DllImport("advapi32.dll")]
    static extern bool AddAce(IntPtr pAcl, uint dwAceRevision, uint dwStartingAceIndex, IntPtr pAceList, uint nAceListLength);

    [DllImport("advapi32.dll")]
    static extern bool InitializeAcl(IntPtr pAcl, uint nAclLength, uint dwAclRevision);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidIdentifierAuthority(IntPtr pSid);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthority(IntPtr pSid, uint nSubAuthority);

    [DllImport("advapi32.dll")]
    static extern IntPtr GetSidSubAuthorityCount(IntPtr pSid);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(
        IntPtr SecurityDescriptor, uint StringSDRevision, uint SecurityInformation,
        out IntPtr StringSecurityDescriptor, out uint StringSecurityDescriptorLen);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(
        string StringSecurityDescriptor, uint StringSDRevision,
        out IntPtr SecurityDescriptor, IntPtr SecurityDescriptorSize);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSidToStringSidW(IntPtr Sid, out IntPtr StringSid);

    [DllImport("advapi32.dll")]
    static extern bool GetSecurityDescriptorDacl(IntPtr pSecurityDescriptor, out bool lpbDaclPresent, out IntPtr pDacl, out bool lpbDaclDefaulted);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    static bool IsAuthority(IntPtr sid, byte authority)
    {
        IntPtr ia = GetSidIdentifierAuthority(sid);
        for (int i = 0; i < 5; i++)
        {
            if (Marshal.ReadByte(ia, i) != 0) return false;
        }
        return Marshal.ReadByte(ia, 5) == authority;
    }

    static bool IsEveryone(IntPtr sid)
    {
        if (!IsAuthority(sid, 1)) return false;
        byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        if (count != 1) return false;
        return Marshal.ReadInt32(GetSidSubAuthority(sid, 0)) == 0;
    }

    static string SidToString(IntPtr sid)
    {
        IntPtr str;
        if (!ConvertSidToStringSidW(sid, out str)) return "?";
        try { return Marshal.PtrToStringUni(str); }
        finally { if (str != IntPtr.Zero) LocalFree(str); }
    }

    // The workspace write identity is S-1-4-x-y (two 30-bit sub-authorities);
    // the private temp identity is S-1-4-x-y-1. Anything else in the S-1-4
    // authority is not a DSH capability SID.
    static bool IsDshSandboxSid(IntPtr sid)
    {
        if (!IsAuthority(sid, 4)) return false;
        byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        if (count != 2 && count != 3) return false;
        for (int i = 0; i < count; i++)
        {
            uint value = (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)i));
            if (value < 1 || value > MAX_SUB_AUTHORITY_30) return false;
        }
        if (count == 3)
        {
            uint third = (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, 2));
            if (third != 1) return false;
        }
        return true;
    }

    static bool IsDshGrant(IntPtr ace, ACE_HEADER h)
    {
        if (h.AceType != 0) return false;
        if ((uint)(h.AceFlags & 0x0F) != SUB_CONTAINERS_AND_OBJECTS_INHERIT) return false;
        if ((uint)Marshal.ReadInt32(ace, 4) != GRANT_MASK) return false;
        return IsDshSandboxSid(new IntPtr(ace.ToInt64() + 8));
    }

    static bool IsAmbientDeny(IntPtr ace, ACE_HEADER h)
    {
        if (h.AceType != 1) return false;
        if ((uint)(h.AceFlags & 0x0F) != CONTAINER_INHERIT_ACE) return false;
        if ((uint)Marshal.ReadInt32(ace, 4) != FILE_DELETE_CHILD) return false;
        return IsEveryone(new IntPtr(ace.ToInt64() + 8));
    }

    static uint ReadLabel(IntPtr sacl)
    {
        if (sacl == IntPtr.Zero) return 0;
        ACL_SIZE_INFORMATION si;
        if (!GetAclInformation(sacl, out si, (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)), ACL_SIZE_INFORMATION_CLASS))
            return 0;
        for (uint i = 0; i < si.AceCount; i++)
        {
            IntPtr ace;
            if (!GetAce(sacl, i, out ace)) continue;
            ACE_HEADER h = (ACE_HEADER)Marshal.PtrToStructure(ace, typeof(ACE_HEADER));
            if (h.AceType != 0x11) continue;
            IntPtr sid = new IntPtr(ace.ToInt64() + 8);
            if (!IsAuthority(sid, 16)) continue;
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if (count == 0) continue;
            return (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        }
        return 0;
    }

    static void ReadDaclFlags(IntPtr dacl, out bool sandboxSid, out bool sandboxInherited, out bool everyoneDeny, out bool everyoneInherited)
    {
        sandboxSid = false;
        sandboxInherited = false;
        everyoneDeny = false;
        everyoneInherited = false;
        if (dacl == IntPtr.Zero) return;
        ACL_SIZE_INFORMATION si;
        if (!GetAclInformation(dacl, out si, (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)), ACL_SIZE_INFORMATION_CLASS))
            return;
        for (uint i = 0; i < si.AceCount; i++)
        {
            IntPtr ace;
            if (!GetAce(dacl, i, out ace)) continue;
            ACE_HEADER h = (ACE_HEADER)Marshal.PtrToStructure(ace, typeof(ACE_HEADER));
            if (h.AceType != 0 && h.AceType != 1) continue;
            bool inherited = (h.AceFlags & INHERITED_ACE) != 0;
            if (IsDshGrant(ace, h))
            {
                if (inherited) sandboxInherited = true;
                else sandboxSid = true;
            }
            if (IsAmbientDeny(ace, h))
            {
                if (inherited) everyoneInherited = true;
                else everyoneDeny = true;
            }
        }
    }

    public static void Probe(string path, out uint level, out bool sandboxSid, out bool sandboxInherited, out bool everyoneDeny, out bool everyoneInherited, out int labelError, out int daclError)
    {
        level = 0;
        sandboxSid = false;
        sandboxInherited = false;
        everyoneDeny = false;
        everyoneInherited = false;
        labelError = 0;
        daclError = 0;

        IntPtr o, g, d, s, sd;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, out o, out g, out d, out s, out sd);
        if (rc == 0)
        {
            try { level = ReadLabel(s); }
            finally { if (sd != IntPtr.Zero) LocalFree(sd); }
        }
        else
        {
            labelError = (int)rc;
        }

        IntPtr o2, g2, d2, s2, sd2;
        uint rc2 = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, out o2, out g2, out d2, out s2, out sd2);
        if (rc2 == 0)
        {
            try { ReadDaclFlags(d2, out sandboxSid, out sandboxInherited, out everyoneDeny, out everyoneInherited); }
            finally { if (sd2 != IntPtr.Zero) LocalFree(sd2); }
        }
        else
        {
            daclError = (int)rc2;
        }
    }

    static bool ShouldRemove(IntPtr ace, ACE_HEADER h, bool removeEveryone)
    {
        if ((h.AceFlags & INHERITED_ACE) != 0) return false;
        if (IsDshGrant(ace, h)) return true;
        if (removeEveryone && IsAmbientDeny(ace, h)) return true;
        return false;
    }

    public static int DescribeRemovable(string path, bool removeEveryone, out string details, out int count, out string error)
    {
        details = "";
        count = 0;
        error = null;
        IntPtr o, g, d, s, sd;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, out o, out g, out d, out s, out sd);
        if (rc != 0)
        {
            error = "GetNamedSecurityInfoW=" + rc;
            return -1;
        }
        try
        {
            if (d == IntPtr.Zero) return 0;
            ACL_SIZE_INFORMATION si;
            if (!GetAclInformation(d, out si, (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)), ACL_SIZE_INFORMATION_CLASS))
            {
                error = "GetAclInformation failed";
                return -1;
            }
            for (uint i = 0; i < si.AceCount; i++)
            {
                IntPtr ace;
                if (!GetAce(d, i, out ace)) continue;
                ACE_HEADER h = (ACE_HEADER)Marshal.PtrToStructure(ace, typeof(ACE_HEADER));
                if (!ShouldRemove(ace, h, removeEveryone)) continue;
                count++;
                uint mask = (uint)Marshal.ReadInt32(ace, 4);
                string kind = h.AceType == 0 ? "allow" : "deny";
                details += kind + " " + SidToString(new IntPtr(ace.ToInt64() + 8))
                    + " mask=0x" + mask.ToString("X") + " flags=0x" + h.AceFlags.ToString("X") + "\n";
            }
            return 0;
        }
        finally { if (sd != IntPtr.Zero) LocalFree(sd); }
    }

    public static int RemoveAces(string path, bool removeEveryone, out int removed, out string error)
    {
        removed = 0;
        error = null;
        IntPtr o, g, d, s, sd;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, out o, out g, out d, out s, out sd);
        if (rc != 0)
        {
            error = "GetNamedSecurityInfoW=" + rc;
            return -1;
        }
        IntPtr newAcl = IntPtr.Zero;
        try
        {
            // A NULL DACL means Everyone has full control; rebuilding it from
            // nothing would silently drop that fact, so report it instead.
            if (d == IntPtr.Zero)
            {
                error = "the object has a NULL DACL";
                return -1;
            }
            ACL_SIZE_INFORMATION si;
            if (!GetAclInformation(d, out si, (uint)Marshal.SizeOf(typeof(ACL_SIZE_INFORMATION)), ACL_SIZE_INFORMATION_CLASS))
            {
                error = "GetAclInformation failed";
                return -1;
            }
            int keepBytes = 8;
            for (uint i = 0; i < si.AceCount; i++)
            {
                IntPtr ace;
                if (!GetAce(d, i, out ace)) continue;
                ACE_HEADER h = (ACE_HEADER)Marshal.PtrToStructure(ace, typeof(ACE_HEADER));
                if (ShouldRemove(ace, h, removeEveryone)) removed++;
                else keepBytes += h.AceSize;
            }
            if (removed == 0) return 0;
            newAcl = Marshal.AllocHGlobal(keepBytes + 16);
            byte revision = Marshal.ReadByte(d);
            if (!InitializeAcl(newAcl, (uint)(keepBytes + 16), revision))
            {
                error = "InitializeAcl failed";
                return -1;
            }
            for (uint i = 0; i < si.AceCount; i++)
            {
                IntPtr ace;
                if (!GetAce(d, i, out ace)) continue;
                ACE_HEADER h = (ACE_HEADER)Marshal.PtrToStructure(ace, typeof(ACE_HEADER));
                if (ShouldRemove(ace, h, removeEveryone)) continue;
                if (!AddAce(newAcl, revision, 0xFFFFFFFF, ace, h.AceSize))
                {
                    error = "AddAce failed at " + i;
                    return -1;
                }
            }
            uint setRc = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, newAcl, IntPtr.Zero);
            if (setRc != 0)
            {
                error = "SetNamedSecurityInfoW=" + setRc;
                return -1;
            }
            return 0;
        }
        finally
        {
            if (newAcl != IntPtr.Zero) Marshal.FreeHGlobal(newAcl);
            if (sd != IntPtr.Zero) LocalFree(sd);
        }
    }

    public static int SaveSddl(string path, out string sddl, out string error)
    {
        sddl = null;
        error = null;
        IntPtr o, g, d, s, sd;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, out o, out g, out d, out s, out sd);
        if (rc != 0)
        {
            error = "GetNamedSecurityInfoW=" + rc;
            return -1;
        }
        try
        {
            IntPtr str;
            uint len;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, out str, out len))
            {
                error = "ConvertSecurityDescriptorToStringSecurityDescriptorW failed";
                return -1;
            }
            try { sddl = Marshal.PtrToStringUni(str); }
            finally { if (str != IntPtr.Zero) LocalFree(str); }
            return 0;
        }
        finally { if (sd != IntPtr.Zero) LocalFree(sd); }
    }

    public static int SaveDacl(string path, out string sddl, out string error)
    {
        sddl = null;
        error = null;
        IntPtr o, g, d, s, sd;
        uint rc = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, out o, out g, out d, out s, out sd);
        if (rc != 0)
        {
            error = "GetNamedSecurityInfoW=" + rc;
            return -1;
        }
        try
        {
            IntPtr str;
            uint len;
            if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, DACL_SECURITY_INFORMATION, out str, out len))
            {
                error = "ConvertSecurityDescriptorToStringSecurityDescriptorW failed";
                return -1;
            }
            try { sddl = Marshal.PtrToStringUni(str); }
            finally { if (str != IntPtr.Zero) LocalFree(str); }
            return 0;
        }
        finally { if (sd != IntPtr.Zero) LocalFree(sd); }
    }

    public static int RestoreSddl(string path, string sddl, out string error)
    {
        error = null;
        IntPtr sd;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero))
        {
            error = "ConvertStringSecurityDescriptorToSecurityDescriptorW failed";
            return -1;
        }
        try
        {
            bool present, defaulted;
            IntPtr dacl;
            GetSecurityDescriptorDacl(sd, out present, out dacl, out defaulted);
            if (!present)
            {
                error = "the saved SDDL carries no DACL";
                return -1;
            }
            uint rc = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (rc != 0)
            {
                error = "SetNamedSecurityInfoW=" + rc;
                return -1;
            }
            return 0;
        }
        finally { if (sd != IntPtr.Zero) LocalFree(sd); }
    }
}
'@

$script:ExecutableExtensions = @('.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.ps1', '.psm1', '.psd1', '.vbs', '.wsf', '.scr', '.cpl', '.ocx', '.sys', '.node', '.jar', '.py', '.pyw', '.js', '.mjs')
$script:Start = Get-Date
$script:Count = 0
$script:Truncated = $false

function Get-Info([string]$p) {
    $level = [uint32]0
    $sid = $false
    $sidInherited = $false
    $deny = $false
    $denyInherited = $false
    $labelError = 0
    $daclError = 0
    [void][Wi]::Probe((ConvertTo-LongPath $p), [ref]$level, [ref]$sid, [ref]$sidInherited, [ref]$deny, [ref]$denyInherited, [ref]$labelError, [ref]$daclError)
    [pscustomobject]@{
        path = (ConvertFrom-LongPath $p)
        level = [int64]$level
        low = ($labelError -eq 0 -and $level -eq 0x1000)
        readable = ($labelError -eq 0)
        labelError = $labelError
        daclReadable = ($daclError -eq 0)
        daclError = $daclError
        sandboxSid = [bool]$sid
        sandboxInherited = [bool]$sidInherited
        everyoneDeny = [bool]$deny
        everyoneInherited = [bool]$denyInherited
    }
}

function Test-Skip([string]$p) {
    $name = [System.IO.Path]::GetFileName((ConvertFrom-LongPath $p))
    return ($name -eq '$Recycle.Bin' -or $name -eq 'System Volume Information')
}

# 规范化排除清单：接受数组或逗号/分号分隔的字符串，去掉引号、空白与结尾
# 分隔符，去重后返回小写条目。
function ConvertTo-ExcludeList([string[]]$values) {
    $list = New-Object System.Collections.ArrayList
    foreach ($value in @($values)) {
        if (-not $value) { continue }
        foreach ($part in ($value -split '[,;]')) {
            $item = $part.Trim().Trim('"').Trim("'").TrimEnd('\').ToLowerInvariant()
            if ($item -and -not $list.Contains($item)) { [void]$list.Add($item) }
        }
    }
    return @($list)
}

# 判断路径是否落在排除清单内。不含反斜杠的条目按目录名匹配任意层级；
# 含反斜杠的条目按相对根的路径前缀匹配。根目录自身永远返回 false。
function Test-ExcludedPath([string]$root, [string]$path, [string[]]$excludes) {
    if (-not $excludes -or $excludes.Count -eq 0) { return $false }
    $rootKey = $root.TrimEnd('\')
    $pathKey = $path.TrimEnd('\')
    if ($pathKey.Length -le $rootKey.Length) { return $false }
    if (-not $pathKey.StartsWith($rootKey, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
    $relative = $pathKey.Substring($rootKey.Length).TrimStart('\').ToLowerInvariant()
    foreach ($exclude in $excludes) {
        if ($exclude.Contains('\')) {
            if ($relative -eq $exclude -or $relative.StartsWith($exclude + '\')) { return $true }
        } else {
            foreach ($segment in ($relative -split '\\')) {
                if ($segment -eq $exclude) { return $true }
            }
        }
    }
    return $false
}

function Test-FileCandidate([string]$p, [bool]$allFiles) {
    if ($allFiles) { return $true }
    $ext = [System.IO.Path]::GetExtension($p).ToLowerInvariant()
    return ($script:ExecutableExtensions -contains $ext)
}

function Add-ObjectHit($hits, $info) {
    if ($info.low -or $info.sandboxSid -or $info.sandboxInherited -or $info.everyoneDeny -or $info.everyoneInherited) {
        [void]$hits.Add([pscustomobject]@{
            path = $info.path
            low = [bool]$info.low
            sandboxSid = [bool]$info.sandboxSid
            sandboxInherited = [bool]$info.sandboxInherited
            everyoneDeny = [bool]$info.everyoneDeny
            everyoneInherited = [bool]$info.everyoneInherited
        })
        return $true
    }
    return $false
}

function Invoke-Scan([string]$root, [bool]$allFiles, [int]$maxObjects, [string[]]$excludes = @()) {
    $hits = New-Object System.Collections.ArrayList
    $unreadable = New-Object System.Collections.ArrayList
    $daclUnreadable = New-Object System.Collections.ArrayList
    $excluded = New-Object System.Collections.ArrayList
    $errors = New-Object System.Collections.ArrayList
    $dirs = 0
    $files = 0
    $script:Count = 1
    $script:Truncated = $false

    $rootInfo = Get-Info $root
    if (-not $rootInfo.readable) { [void]$unreadable.Add($rootInfo) }
    else { [void](Add-ObjectHit $hits $rootInfo) }
    if (-not $rootInfo.daclReadable) { [void]$daclUnreadable.Add($rootInfo) }
    $dirs++

    $stack = New-Object System.Collections.Stack
    $stack.Push((ConvertTo-LongPath $root))
    while ($stack.Count -gt 0) {
        if ($script:Count -ge $maxObjects) { $script:Truncated = $true; break }
        $dir = $stack.Pop()
        try {
            foreach ($child in [System.IO.Directory]::EnumerateDirectories($dir)) {
                if ($script:Count -ge $maxObjects) { $script:Truncated = $true; break }
                $childNative = ConvertFrom-LongPath $child
                if ((Test-Skip $child) -or (Test-Reparse $child)) { continue }
                # 排除目录不计数、不入命中，只记录数量与样本，供结果与记录说明。
                if (Test-ExcludedPath $root $childNative $excludes) {
                    [void]$excluded.Add($childNative)
                    continue
                }
                $script:Count++
                $dirs++
                $info = Get-Info $childNative
                if (-not $info.readable) { [void]$unreadable.Add($info) }
                else { [void](Add-ObjectHit $hits $info) }
                if (-not $info.daclReadable) { [void]$daclUnreadable.Add($info) }
                $stack.Push($child)
            }
            foreach ($file in [System.IO.Directory]::EnumerateFiles($dir)) {
                if ($script:Count -ge $maxObjects) { $script:Truncated = $true; break }
                if (-not (Test-FileCandidate $file $allFiles)) { continue }
                $fileNative = ConvertFrom-LongPath $file
                if (Test-ExcludedPath $root $fileNative $excludes) {
                    [void]$excluded.Add($fileNative)
                    continue
                }
                $script:Count++
                $files++
                $info = Get-Info $fileNative
                if (-not $info.readable) { [void]$unreadable.Add($info) }
                else { [void](Add-ObjectHit $hits $info) }
                if (-not $info.daclReadable) { [void]$daclUnreadable.Add($info) }
            }
        } catch {
            [void]$errors.Add(@{ path = (ConvertFrom-LongPath $dir); message = $_.Exception.Message })
        }
    }

    $low = @($hits | Where-Object { $_.low }).Count
    $sid = @($hits | Where-Object { $_.sandboxSid }).Count
    $sidInherited = @($hits | Where-Object { $_.sandboxInherited }).Count
    $deny = @($hits | Where-Object { $_.everyoneDeny }).Count
    $denyInherited = @($hits | Where-Object { $_.everyoneInherited }).Count
    [pscustomobject]@{
        path = $root
        dirs = $dirs
        files = $files
        low = [int]$low
        sandboxSid = [int]$sid
        sandboxInherited = [int]$sidInherited
        everyoneDeny = [int]$deny
        everyoneInherited = [int]$denyInherited
        unreadable = [int]$unreadable.Count
        unreadableSamples = @($unreadable | Select-Object -First 20 | ForEach-Object { $_.path })
        daclUnreadable = [int]$daclUnreadable.Count
        daclUnreadableSamples = @($daclUnreadable | Select-Object -First 20 | ForEach-Object { $_.path })
        excluded = [int]$excluded.Count
        excludedSamples = @($excluded | Select-Object -First 20)
        hits = @($hits)
        errors = @($errors)
        truncated = [bool]$script:Truncated
        elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
    }
}

function Get-BackupRoot {
    if ($BackupRoot) {
        if (-not [System.IO.Path]::IsPathRooted($BackupRoot)) { throw "-BackupRoot must be an absolute path: $BackupRoot" }
        $base = $BackupRoot
    } else {
        $base = Join-Path $env:LOCALAPPDATA 'dsh-workspace-integrity'
    }
    if (-not (Test-Path -LiteralPath $base)) { New-Item -ItemType Directory -Path $base -Force | Out-Null }
    return $base
}

function Save-ObjectDacl([string]$recordDir, [string]$objectPath) {
    $objectsDir = Join-Path $recordDir 'objects'
    if (-not (Test-Path -LiteralPath $objectsDir)) { New-Item -ItemType Directory -Path $objectsDir -Force | Out-Null }
    $file = Join-Path $objectsDir ((Get-PathHash $objectPath) + '.sddl')
    $sddl = $null
    $err = $null
    $rc = [Wi]::SaveDacl((ConvertTo-LongPath $objectPath), [ref]$sddl, [ref]$err)
    if ($rc -ne 0 -or -not $sddl) { return $null }
    [System.IO.File]::WriteAllText($file, $sddl, (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ path = $objectPath; file = $file }
}

function New-BackupRecord([string]$root, $scan, [bool]$requestedRemoveAces, [bool]$effectiveRemoveAces, [bool]$fast, [string]$trigger, [string[]]$excludes = @()) {
    $base = Get-BackupRoot
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dir = Join-Path $base ("backup-" + $stamp + "-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $sddl = $null
    $err = $null
    $rc = [Wi]::SaveSddl((ConvertTo-LongPath $root), [ref]$sddl, [ref]$err)
    $sddlSaved = ($rc -eq 0 -and [bool]$sddl)
    if ($sddlSaved) {
        [System.IO.File]::WriteAllText((Join-Path $dir 'root.sddl'), $sddl, (New-Object System.Text.UTF8Encoding($false)))
    }
    $rootInfo = Get-Info $root
    $manifest = [ordered]@{
        createdAt = (Get-Date).ToString('o')
        root = $root
        rootLabel = $(if ($rootInfo.low) { 'Low' } else { 'Other' })
        sddl = $sddl
        sddlSaved = $sddlSaved
        requestedRemoveAces = $requestedRemoveAces
        removeAces = $effectiveRemoveAces
        fast = $fast
        trigger = $trigger
        # 记录本次排除范围与数量：被跳过的目录必须可见，不能当成已修复。
        excludeDirs = @($excludes)
        excluded = [int]$scan.excluded
        excludedSamples = @($scan.excludedSamples)
        truncated = [bool]$scan.truncated
        removedAces = 0
        acesSkipped = ($requestedRemoveAces -and -not $effectiveRemoveAces)
        objects = @()
        failed = @()
        ok = $null
        hits = @($scan.hits)
    }
    [System.IO.File]::WriteAllText((Join-Path $dir 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ dir = $dir; manifest = $manifest; sddlError = $err; sddlSaved = $sddlSaved }
}

function Update-BackupManifest([string]$dir, [hashtable]$patch) {
    $path = Join-Path $dir 'manifest.json'
    try {
        $manifest = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $obj = [ordered]@{}
        foreach ($prop in $manifest.PSObject.Properties) { $obj[$prop.Name] = $prop.Value }
        foreach ($key in $patch.Keys) { $obj[$key] = $patch[$key] }
        $tmp = $path + '.tmp'
        [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
        Move-Item -LiteralPath $tmp -Destination $path -Force
        return $true
    } catch {
        return $false
    }
}

function Invoke-Fix([string]$root, [bool]$removeAces, [bool]$allFiles, [bool]$fast, [int]$maxObjects, [string]$trigger = 'manual', [string[]]$excludes = @()) {
    $requestedRemoveAces = $removeAces
    # -Fast 不预扫，无法找到可删的 ACE；直接拒绝该组合，避免静默空转。
    if ($fast -and $removeAces) {
        throw "-Fast and -RemoveAces cannot be combined: a fast run does not pre-scan, so it cannot find ACEs to remove. Omit -Fast for a full repair."
    }

    if ($WhatIf) {
        $plan = New-Object System.Collections.ArrayList
        $probe = Get-Info $root
        [void]$plan.Add("label: set the root tree to Medium" + $(if ($probe.low) { '' } else { ' (the root is not Low; a real run would skip)' }))
        if ($removeAces) {
            [void]$plan.Add('aces: remove explicit DSH sandbox grants and the ambient delete deny from scanned hits')
        }
        $scan = Invoke-Scan $root $allFiles $maxObjects $excludes
        if ($scan.truncated) { [void]$plan.Add('scan: would be truncated at MaxObjects') }
        if ($scan.excluded -gt 0) { [void]$plan.Add("excluded directories: $($scan.excluded)") }
        [void]$plan.Add("hits: $($scan.hits.Count), low: $($scan.low), sandboxSid: $($scan.sandboxSid), everyoneDeny: $($scan.everyoneDeny)")
        return [pscustomobject]@{
            ok = $true
            action = 'fix'
            path = $root
            whatIf = $true
            backupDir = $null
            labelReadable = [bool]$probe.readable
            low = [int]$scan.low
            sandboxSid = [int]$scan.sandboxSid
            everyoneDeny = [int]$scan.everyoneDeny
            unreadable = [int]$scan.unreadable
            daclUnreadable = [int]$scan.daclUnreadable
            excluded = [int]$scan.excluded
            excludedSamples = @($scan.excludedSamples)
            truncated = [bool]$scan.truncated
            requestedRemoveAces = $removeAces
            removedAces = 0
            acesSkipped = $false
            rootOnly = $false
            plan = @($plan)
            failed = @()
            note = $null
            warning = $null
            elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
        }
    }

    # 幂等跳过：只有根已经是 Medium 且没有待处理残留时才跳过。手动修复会
    # 扫描子树，因为子对象可能仍有 Low（例如上一次 /T 部分失败）；fast 不
    # 预扫，只按根判断。扫描结果在继续修复时复用，避免重复遍历。
    $preScan = $null
    $skip = $false
    if ($fast) {
        $probe = Get-Info $root
        $skip = ($probe.readable -and -not $probe.low)
    } elseif (-not $removeAces) {
        $probe = Get-Info $root
        if ($probe.readable -and -not $probe.low) {
            $preScan = Invoke-Scan $root $allFiles $maxObjects $excludes
            $skip = ($preScan.low -eq 0)
        }
    }
    if ($skip) {
        $skipNote = if ($preScan) { 'No Low labels remain; skipped.' } else { 'The root label is not Low; skipped.' }
        return [pscustomobject]@{
            ok = $true
            action = 'fix'
            path = $root
            whatIf = $false
            backupDir = $null
            labelReadable = $true
            low = $(if ($preScan) { [int]$preScan.low } else { 0 })
            sandboxSid = $(if ($preScan) { [int]$preScan.sandboxSid } else { 0 })
            everyoneDeny = $(if ($preScan) { [int]$preScan.everyoneDeny } else { 0 })
            unreadable = $(if ($preScan) { [int]$preScan.unreadable } else { 0 })
            daclUnreadable = $(if ($preScan) { [int]$preScan.daclUnreadable } else { 0 })
            excluded = $(if ($preScan) { [int]$preScan.excluded } else { $null })
            excludedSamples = $(if ($preScan) { @($preScan.excludedSamples) } else { @() })
            truncated = $false
            requestedRemoveAces = $requestedRemoveAces
            removedAces = 0
            acesSkipped = $false
            rootOnly = $fast
            plan = @()
            failed = @()
            note = $skipNote
            warning = $null
            elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
        }
    }

    $scan = $null
    if ($preScan) {
        $scan = $preScan
    } elseif (-not $fast) {
        $scan = Invoke-Scan $root $allFiles $maxObjects $excludes
    } else {
        $scan = [pscustomobject]@{
            hits = @(); low = 0; sandboxSid = 0; everyoneDeny = 0; unreadable = 0; daclUnreadable = 0
            excluded = 0; excludedSamples = @(); truncated = $false
        }
    }

    $record = New-BackupRecord $root $scan $requestedRemoveAces $removeAces $fast $trigger $excludes
    $failed = New-Object System.Collections.ArrayList
    $objects = New-Object System.Collections.ArrayList

    $runResult = Set-LabelTree $root '(OI)(CI)M'
    if (-not $runResult.ok) {
        [void]$failed.Add(@{ path = $root; message = 'could not set the mandatory label (WRITE_OWNER or SeRelabelPrivilege is missing).' })
    }
    if ($runResult.restoreError) {
        [void]$failed.Add(@{ path = $root; message = $runResult.restoreError })
    }

    $rootAfter = Get-Info $root
    $removed = 0
    $acesSkipped = $false
    if ($removeAces) {
        # Never delete ACEs while the label repair failed: the sandbox would be
        # weakened without the repair it was meant to enable.
        if (-not $runResult.ok -or -not $rootAfter.readable -or $rootAfter.low) {
            $acesSkipped = $true
            [void]$failed.Add(@{ path = $root; message = 'skipped ACE removal: the root label is still Low or unreadable' })
        } else {
            foreach ($hit in @($record.manifest.hits)) {
                # 只处理显式、可删除的命中；继承项留给父级，单独统计。
                if (-not ($hit.sandboxSid -or $hit.everyoneDeny)) { continue }
                # 防御：命中清单可能来自旧记录，排除目录不得删除。
                if (Test-ExcludedPath $root $hit.path $excludes) { continue }
                $saved = Save-ObjectDacl $record.dir $hit.path
                if ($null -eq $saved) {
                    [void]$failed.Add(@{ path = $hit.path; message = 'could not save the object DACL; ACE removal skipped' })
                    continue
                }
                [void]$objects.Add($saved)
                $count = 0
                $err = $null
                $rc = [Wi]::RemoveAces((ConvertTo-LongPath $hit.path), [bool]$hit.everyoneDeny, [ref]$count, [ref]$err)
                if ($rc -eq 0) { $removed += $count }
                else { [void]$failed.Add(@{ path = $hit.path; message = $err }) }
            }
        }
    }

    $verify = $null
    if (-not $fast) {
        $verify = Invoke-Scan $root $allFiles $maxObjects $excludes
    } else {
        $rootInfo = Get-Info $root
        $verify = [pscustomobject]@{
            low = $(if ($rootInfo.low) { 1 } else { 0 })
            sandboxSid = 0
            everyoneDeny = 0
            unreadable = 0
            daclUnreadable = 0
            excluded = 0
            truncated = $false
        }
    }

    $rootInfo = Get-Info $root
    $ok = ($rootInfo.readable -and (-not $rootInfo.low) -and (@($failed).Count -eq 0))
    if ($ok -and -not $fast) {
        if ($verify.low -ne 0) { $ok = $false }
        if ($removeAces -and ($verify.sandboxSid -ne 0 -or $verify.everyoneDeny -ne 0)) { $ok = $false }
        # 扫描被截断时无法证明整棵树干净，不允许报成功。
        if ($scan.truncated -or $verify.truncated) { $ok = $false }
    }

    $warning = $null
    if ($scan.truncated) {
        $warning = 'The scan was truncated at MaxObjects; the result covers only the scanned objects.'
    }
    if ($scan.excluded -gt 0) {
        # 被排除的目录既未验证也未清理，必须显式提示，避免误判成已修复。
        $excludedWarning = "$($scan.excluded) directories were excluded from the scan; they were not verified or cleaned"
        $warning = if ($warning) { $warning + ' ' + $excludedWarning } else { $excludedWarning }
    }

    $note = $null
    if (-not $runResult.ok) {
        $note = 'The root label could not be changed: the account lacks WRITE_OWNER and SeRelabelPrivilege; run from an administrator shell.'
    } elseif (-not $rootInfo.readable) {
        $note = 'The mandatory label could not be read back, so the repair cannot be verified; inspect the root with icacls from a normal shell.'
    } elseif ($acesSkipped) {
        $note = 'The root label was repaired, but ACE removal was skipped because the root was not in a safe state.'
    } elseif ($scan.truncated) {
        $note = 'The scan was truncated, so only the scanned objects were repaired.'
    }

    [void](Update-BackupManifest $record.dir @{
        removedAces = $removed
        acesSkipped = $acesSkipped
        objects = @($objects)
        failed = @($failed)
        truncated = [bool]$scan.truncated
        excluded = [int]$scan.excluded
        excludedSamples = @($scan.excludedSamples)
        ok = $ok
        verifyLow = [int]$verify.low
        verifySandboxSid = [int]$verify.sandboxSid
        verifyEveryoneDeny = [int]$verify.everyoneDeny
        daclUnreadable = [int]$verify.daclUnreadable
    })

    return [pscustomobject]@{
        ok = $ok
        action = 'fix'
        path = $root
        whatIf = $false
        backupDir = $record.dir
        labelReadable = [bool]$rootInfo.readable
        low = [int]$verify.low
        sandboxSid = [int]$verify.sandboxSid
        everyoneDeny = [int]$verify.everyoneDeny
        unreadable = [int]$verify.unreadable
        daclUnreadable = [int]$verify.daclUnreadable
        excluded = [int]$scan.excluded
        excludedSamples = @($scan.excludedSamples)
        truncated = [bool]$scan.truncated
        requestedRemoveAces = $requestedRemoveAces
        removedAces = [int]$removed
        acesSkipped = $acesSkipped
        rootOnly = $fast
        objectsSaved = $objects.Count
        sddlSaved = $record.sddlSaved
        plan = @()
        failed = @($failed)
        note = $note
        warning = $warning
        elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
    }
}

function Invoke-Rollback([string]$dir, [string[]]$excludes = @()) {
    $manifestPath = Join-Path $dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "No manifest.json in $dir" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $root = [string]$manifest.root
    if (-not $root) { throw "The record has no root path: $dir" }
    $failed = New-Object System.Collections.ArrayList
    $restored = 0
    $daclRestored = $false
    $objectsRestored = 0
    $preScanned = -not [bool]$manifest.fast

    if ($manifest.sddl) {
        $err = $null
        $rc = [Wi]::RestoreSddl((ConvertTo-LongPath $root), [string]$manifest.sddl, [ref]$err)
        if ($rc -eq 0) { $restored++; $daclRestored = $true }
        else { [void]$failed.Add(@{ path = $root; message = "DACL: $err" }) }
    } else {
        [void]$failed.Add(@{ path = $root; message = 'the record has no root DACL to restore' })
    }

    foreach ($object in @($manifest.objects)) {
        if ($null -eq $object -or -not $object.path -or -not $object.file) { continue }
        if (-not (Test-Path -LiteralPath ([string]$object.file))) {
            [void]$failed.Add(@{ path = [string]$object.path; message = 'the recorded object DACL file is missing' })
            continue
        }
        $sddl = Get-Content -LiteralPath ([string]$object.file) -Raw -Encoding UTF8
        $err = $null
        $rc = [Wi]::RestoreSddl((ConvertTo-LongPath ([string]$object.path)), $sddl, [ref]$err)
        if ($rc -eq 0) { $restored++; $objectsRestored++ }
        else { [void]$failed.Add(@{ path = [string]$object.path; message = "DACL: $err" }) }
    }

    if ($manifest.rootLabel -eq 'Low') {
        $labelRun = Set-LabelTree $root '(OI)(CI)L'
        if ($labelRun.ok) { $restored++ }
        else { [void]$failed.Add(@{ path = $root; message = 'could not restore the Low label on the tree.' }) }
        if ($labelRun.restoreError) { [void]$failed.Add(@{ path = $root; message = $labelRun.restoreError }) }
    }

    $remaining = $null
    # 复扫沿用同一排除清单，保证「剩余 Low」与修复时的范围一致。
    try { $remaining = Invoke-Scan $root $false $MaxObjects $excludes } catch { }

    return [pscustomobject]@{
        ok = (@($failed).Count -eq 0)
        action = 'rollback'
        path = $root
        backupDir = $dir
        restored = $restored
        daclRestored = $daclRestored
        objectsRestored = $objectsRestored
        remainingLow = $(if ($remaining) { [int]$remaining.low } else { $null })
        excluded = $(if ($remaining) { [int]$remaining.excluded } else { $null })
        preScanned = $preScanned
        failed = @($failed)
        note = $(if ($preScanned) { $null } else { 'This record came from an automatic cleanup, which does not pre-scan: restored counts only the DACL and label actions it performed.' })
        elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
    }
}

function Get-Records {
    $base = Get-BackupRoot
    $items = New-Object System.Collections.ArrayList
    foreach ($dir in @(Get-ChildItem -LiteralPath $base -Directory -Force -ErrorAction SilentlyContinue)) {
        $manifestPath = Join-Path $dir.FullName 'manifest.json'
        if (-not (Test-Path -LiteralPath $manifestPath)) { continue }
        try {
            $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $fast = [bool]$manifest.fast
            [void]$items.Add([pscustomobject]@{
                createdAt = $manifest.createdAt
                root = $manifest.root
                dir = $dir.FullName
                low = $(if ($fast) { $null } else { @($manifest.hits | Where-Object { $_.low }).Count })
                fast = $fast
                trigger = [string]$manifest.trigger
                removedAces = $(if ($null -ne $manifest.removedAces) { [int]$manifest.removedAces } else { $null })
                acesSkipped = [bool]$manifest.acesSkipped
                truncated = [bool]$manifest.truncated
                excluded = $(if ($null -ne $manifest.excluded) { [int]$manifest.excluded } else { $null })
                ok = $(if ($null -ne $manifest.ok) { [bool]$manifest.ok } else { $null })
            })
        } catch { }
    }
    return @($items | Sort-Object { try { [datetime]::Parse([string]$_.createdAt) } catch { [datetime]::MinValue } } -Descending)
}

# 先把排除清单规范化一次，后续扫描、修复与回滚共用同一份范围。
$excludes = ConvertTo-ExcludeList $ExcludeDirs

try {
    switch ($Action) {
        'records' {
            $obj = [ordered]@{ ok = $true; action = 'records'; records = @(Get-Records); elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds }
        }
        'rollback' {
            if (-not $BackupDir) { throw 'rollback needs -BackupDir' }
            $manifestPath = Join-Path $BackupDir 'manifest.json'
            if (-not (Test-Path -LiteralPath $manifestPath)) { throw "No manifest.json in $BackupDir" }
            $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $root = [string]$manifest.root
            if (-not $root) { throw "The record has no root path: $BackupDir" }
            $danger = Test-DangerousRoot $root
            if ($danger -and -not $AllowDangerousRoot) { throw "Refusing to roll back $danger ($root). Pass -AllowDangerousRoot to override." }
            $lock = Enter-PathLock $root
            try { $obj = Invoke-Rollback $BackupDir $excludes } finally { Exit-PathLock $lock }
        }
        default {
            if (-not $Path) { throw "$Action needs -Path" }
            if (-not (Test-Path -LiteralPath $Path)) { throw "Path does not exist: $Path" }
            $item = Get-Item -LiteralPath $Path -Force
            if (-not $item.PSIsContainer) { throw "Expected a directory: $Path" }
            $root = (Resolve-Path -LiteralPath $Path).ProviderPath
            if ($Action -eq 'fix') {
                if (Test-Reparse $root) { throw "Refusing a reparse-point root: $root" }
                $danger = Test-DangerousRoot $root
                if ($danger -and -not $AllowDangerousRoot) { throw "Refusing to modify $danger ($root). Pass -AllowDangerousRoot to override." }
                if ($danger) { [Console]::Error.WriteLine("warning: modifying a dangerous root because -AllowDangerousRoot was passed: $root") }
            }
            if ($Action -eq 'scan') {
                $scan = Invoke-Scan $root ([bool]$AllFiles) $MaxObjects $excludes
                $obj = [ordered]@{
                    ok = $true
                    action = 'scan'
                    path = $root
                    dirs = $scan.dirs
                    files = $scan.files
                    low = $scan.low
                    sandboxSid = $scan.sandboxSid
                    sandboxInherited = $scan.sandboxInherited
                    everyoneDeny = $scan.everyoneDeny
                    everyoneInherited = $scan.everyoneInherited
                    unreadable = $scan.unreadable
                    unreadableSamples = $scan.unreadableSamples
                    daclUnreadable = $scan.daclUnreadable
                    daclUnreadableSamples = $scan.daclUnreadableSamples
                    excluded = $scan.excluded
                    excludedSamples = $scan.excludedSamples
                    truncated = $scan.truncated
                    errors = @($scan.errors | Select-Object -First 20)
                    hitsTotal = $scan.hits.Count
                    hits = @($scan.hits | Select-Object -First 500)
                    failed = @()
                    elapsedMs = $scan.elapsedMs
                }
            } elseif ($Action -eq 'verify') {
                $scan = Invoke-Scan $root ([bool]$AllFiles) $MaxObjects $excludes
                $obj = [ordered]@{
                    # 截断时无法证明整棵树干净，verify 不报成功。
                    ok = ($scan.low -eq 0 -and $scan.sandboxSid -eq 0 -and $scan.everyoneDeny -eq 0 -and -not $scan.truncated)
                    action = 'verify'
                    path = $root
                    low = $scan.low
                    sandboxSid = $scan.sandboxSid
                    sandboxInherited = $scan.sandboxInherited
                    everyoneDeny = $scan.everyoneDeny
                    everyoneInherited = $scan.everyoneInherited
                    unreadable = $scan.unreadable
                    daclUnreadable = $scan.daclUnreadable
                    excluded = $scan.excluded
                    excludedSamples = $scan.excludedSamples
                    truncated = $scan.truncated
                    errors = @($scan.errors | Select-Object -First 20)
                    hitsTotal = $scan.hits.Count
                    hits = @($scan.hits | Select-Object -First 500)
                    failed = @()
                    elapsedMs = $scan.elapsedMs
                }
            } else {
                if ($WhatIf) {
                    $obj = Invoke-Fix $root ([bool]$RemoveAces) ([bool]$AllFiles) ([bool]$Fast) $MaxObjects $Trigger $excludes
                } else {
                    $lock = Enter-PathLock $root
                    try { $obj = Invoke-Fix $root ([bool]$RemoveAces) ([bool]$AllFiles) ([bool]$Fast) $MaxObjects $Trigger $excludes }
                    finally { Exit-PathLock $lock }
                }
            }
        }
    }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 10))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    [Console]::Out.WriteLine(([ordered]@{ ok = $false; action = $Action; error = $_.Exception.Message } | ConvertTo-Json -Depth 6))
    exit 1
}
