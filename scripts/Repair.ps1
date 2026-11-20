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

    [int]$MaxObjects = 20000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [Console]::OutputEncoding = $utf8
    $OutputEncoding = $utf8
} catch { }

function Write-Stage([string]$Message) {
    [Console]::Error.WriteLine($Message)
}

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
    $direct = Invoke-Icacls @($root, '/setintegritylevel', $flags, '/T', '/C', '/Q')
    $denied = ($direct.text -match 'Access is denied|拒绝访问')
    if ($direct.code -eq 0 -and -not $denied) {
        return [pscustomobject]@{ ok = $true; text = $direct.text; fallback = $false; restoreError = $null }
    }

    # A file's owner has implicit READ_CONTROL/WRITE_DAC, not WRITE_OWNER, so a
    # root without an explicit FullControl ACE cannot receive a label change.
    # Grant FullControl through WRITE_DAC, retry, then restore the saved DACL.
    $sddl = $null
    $err = $null
    $saveRc = [Wi]::SaveSddl((ConvertTo-LongPath $root), [ref]$sddl, [ref]$err)
    if ($saveRc -ne 0 -or -not $sddl) {
        return [pscustomobject]@{ ok = $false; text = $direct.text; fallback = $false; restoreError = "could not save the root DACL: $err" }
    }

    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $null = Invoke-Icacls @($root, '/grant', ($user + ':(OI)(CI)(F)'), '/C', '/Q')
    $retry = Invoke-Icacls @($root, '/setintegritylevel', $flags, '/T', '/C', '/Q')
    $restoreError = $null
    $restoreErr = $null
    $restoreRc = [Wi]::RestoreSddl((ConvertTo-LongPath $root), [string]$sddl, [ref]$restoreErr)
    if ($restoreRc -ne 0) { $restoreError = "DACL restore failed: $restoreErr" }

    $retryDenied = ($retry.text -match 'Access is denied|拒绝访问')
    return [pscustomobject]@{
        ok = ($retry.code -eq 0 -and -not $retryDenied -and -not $restoreError)
        text = ($direct.text + "`n" + $retry.text)
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
            byte count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
            if (count == 0) continue;
            return (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(count - 1)));
        }
        return 0;
    }

    static void ReadDaclFlags(IntPtr dacl, out bool sandboxSid, out bool everyoneDeny)
    {
        sandboxSid = false;
        everyoneDeny = false;
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
            IntPtr sid = new IntPtr(ace.ToInt64() + 8);
            if (IsAuthority(sid, 4)) sandboxSid = true;
            if (h.AceType == 1 && IsEveryone(sid))
            {
                uint mask = (uint)Marshal.ReadInt32(ace, 4);
                if ((mask & FILE_DELETE_CHILD) != 0) everyoneDeny = true;
            }
        }
    }

    public static void Probe(string path, out uint level, out bool sandboxSid, out bool everyoneDeny, out int labelError, out int daclError)
    {
        level = 0;
        sandboxSid = false;
        everyoneDeny = false;
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
            try { ReadDaclFlags(d2, out sandboxSid, out everyoneDeny); }
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
        if (h.AceType != 0 && h.AceType != 1) return false;
        IntPtr sid = new IntPtr(ace.ToInt64() + 8);
        if (IsAuthority(sid, 4)) return true;
        if (removeEveryone && h.AceType == 1 && IsEveryone(sid))
        {
            uint mask = (uint)Marshal.ReadInt32(ace, 4);
            if ((mask & FILE_DELETE_CHILD) != 0) return true;
        }
        return false;
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
            if (d == IntPtr.Zero) return 0;
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
            uint rc = SetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, present ? dacl : IntPtr.Zero, IntPtr.Zero);
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

$script:ExecutableExtensions = @('.exe', '.dll', '.bat', '.cmd', '.com', '.msi', '.ps1', '.scr', '.cpl', '.ocx', '.sys', '.node', '.jar', '.py', '.pyw')
$script:Start = Get-Date
$script:Count = 0
$script:Truncated = $false

function Get-Info([string]$p) {
    $level = [uint32]0
    $sid = $false
    $deny = $false
    $labelError = 0
    $daclError = 0
    [void][Wi]::Probe((ConvertTo-LongPath $p), [ref]$level, [ref]$sid, [ref]$deny, [ref]$labelError, [ref]$daclError)
    [pscustomobject]@{
        path = (ConvertFrom-LongPath $p)
        level = [int64]$level
        low = ($labelError -eq 0 -and $level -eq 0x1000)
        readable = ($labelError -eq 0)
        labelError = $labelError
        daclReadable = ($daclError -eq 0)
        daclError = $daclError
        sandboxSid = [bool]$sid
        everyoneDeny = [bool]$deny
    }
}

function Test-Reparse([string]$p) {
    try {
        $attr = [System.IO.File]::GetAttributes($p)
        return (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
    } catch { return $true }
}

function Test-Skip([string]$p) {
    $name = [System.IO.Path]::GetFileName((ConvertFrom-LongPath $p))
    return ($name -eq '$Recycle.Bin' -or $name -eq 'System Volume Information')
}

function Test-FileCandidate([string]$p, [bool]$allFiles) {
    if ($allFiles) { return $true }
    $ext = [System.IO.Path]::GetExtension($p).ToLowerInvariant()
    return ($script:ExecutableExtensions -contains $ext)
}

function Add-ObjectHit($hits, $info) {
    if ($info.low -or $info.sandboxSid -or $info.everyoneDeny) {
        [void]$hits.Add([pscustomobject]@{
            path = $info.path
            low = [bool]$info.low
            sandboxSid = [bool]$info.sandboxSid
            everyoneDeny = [bool]$info.everyoneDeny
        })
        return $true
    }
    return $false
}

function Invoke-Scan([string]$root, [bool]$allFiles, [int]$maxObjects) {
    $hits = New-Object System.Collections.ArrayList
    $unreadable = New-Object System.Collections.ArrayList
    $errors = New-Object System.Collections.ArrayList
    $dirs = 0
    $files = 0
    $script:Count = 0
    $script:Truncated = $false

    $rootInfo = Get-Info $root
    if (-not $rootInfo.readable) { [void]$unreadable.Add($rootInfo) }
    else { [void](Add-ObjectHit $hits $rootInfo) }
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
                $script:Count++
                $dirs++
                $info = Get-Info $childNative
                if (-not $info.readable) { [void]$unreadable.Add($info) }
                else { [void](Add-ObjectHit $hits $info) }
                $stack.Push($child)
            }
            foreach ($file in [System.IO.Directory]::EnumerateFiles($dir)) {
                if ($script:Count -ge $maxObjects) { $script:Truncated = $true; break }
                if (-not (Test-FileCandidate $file $allFiles)) { continue }
                $script:Count++
                $files++
                $info = Get-Info (ConvertFrom-LongPath $file)
                if (-not $info.readable) { [void]$unreadable.Add($info) }
                else { [void](Add-ObjectHit $hits $info) }
            }
        } catch {
            [void]$errors.Add(@{ path = (ConvertFrom-LongPath $dir); message = $_.Exception.Message })
        }
    }

    $low = @($hits | Where-Object { $_.low }).Count
    $sid = @($hits | Where-Object { $_.sandboxSid }).Count
    [pscustomobject]@{
        path = $root
        dirs = $dirs
        files = $files
        low = [int]$low
        sandboxSid = [int]$sid
        unreadable = [int]$unreadable.Count
        unreadableSamples = @($unreadable | Select-Object -First 20 | ForEach-Object { $_.path })
        hits = @($hits)
        errors = @($errors)
        truncated = [bool]$script:Truncated
        elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
    }
}

function Get-BackupRoot {
    $base = if ($BackupRoot) { $BackupRoot } else { Join-Path $env:LOCALAPPDATA 'dsh-workspace-integrity' }
    if (-not (Test-Path -LiteralPath $base)) { New-Item -ItemType Directory -Path $base -Force | Out-Null }
    return $base
}

function New-BackupRecord([string]$root, $scan, [bool]$removeAces, [bool]$fast, [string]$trigger) {
    $base = Get-BackupRoot
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dir = Join-Path $base ("backup-" + $stamp + "-" + [guid]::NewGuid().ToString('N').Substring(0, 6))
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $sddl = $null
    $err = $null
    $rc = [Wi]::SaveSddl((ConvertTo-LongPath $root), [ref]$sddl, [ref]$err)
    if ($rc -eq 0 -and $sddl) {
        [System.IO.File]::WriteAllText((Join-Path $dir 'root.sddl'), $sddl, (New-Object System.Text.UTF8Encoding($false)))
    }
    $rootInfo = Get-Info $root
    $manifest = [ordered]@{
        createdAt = (Get-Date).ToString('o')
        root = $root
        rootLabel = $(if ($rootInfo.low) { 'Low' } else { 'Other' })
        sddl = $sddl
        removeAces = $removeAces
        # A fast run skips the pre-scan, so its hit list is empty by
        # construction. Record that fact (and who ran it) so the record never
        # reads as "pre-scanned, found 0 Low" when it was not scanned at all.
        fast = $fast
        trigger = $trigger
        hits = @($scan.hits)
    }
    [System.IO.File]::WriteAllText((Join-Path $dir 'manifest.json'), ($manifest | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
    return [pscustomobject]@{ dir = $dir; manifest = $manifest; sddlError = $err }
}

function Invoke-Fix([string]$root, [bool]$removeAces, [bool]$allFiles, [bool]$fast, [int]$maxObjects, [string]$trigger = 'manual') {
    # Idempotent skip: when no ACE removal was asked for, a root that is already
    # Medium means this run could not change anything. The automatic path always
    # skipped like this; the manual path used to re-scan the whole tree and write
    # a fresh rollback record on every click. `-Fast` also skips this branch even
    # when `-RemoveAces` was passed: a fast run has no pre-scan, so it cannot find
    # ACEs to delete and would only burn a full-tree relabel. A full run must not
    # skip when ACE removal is requested, because it does pre-scan.
    if ($fast -or -not $removeAces) {
        $probe = Get-Info $root
        if ($probe.readable -and -not $probe.low) {
            $skipNote = if ($fast -and $removeAces) {
                'The root label is not Low; skipped. -Fast does not pre-scan, so leftover ACEs were not removed.'
            } else {
                'The root label is not Low; skipped.'
            }
            return [pscustomobject]@{
                ok = $true
                action = 'fix'
                path = $root
                backupDir = $null
                labelReadable = $true
                low = 0
                sandboxSid = $(if ($probe.sandboxSid) { 1 } else { 0 })
                unreadable = 0
                labelsFixed = 0
                removedAces = 0
                failed = @()
                note = $skipNote
                elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
            }
        }
    }

    $scan = $null
    if (-not $fast) {
        $scan = Invoke-Scan $root $allFiles $maxObjects
    } else {
        $scan = [pscustomobject]@{ hits = @(); low = 0; sandboxSid = 0; unreadable = 0 }
    }

    $record = New-BackupRecord $root $scan $removeAces $fast $trigger
    $failed = New-Object System.Collections.ArrayList

    $runResult = Set-LabelTree $root '(OI)(CI)M'
    $code = $runResult.code
    $text = $runResult.text
    $denied = ($text -match 'Access is denied|拒绝访问')
    if (-not $runResult.ok) {
        [void]$failed.Add(@{ path = $root; message = 'could not set the mandatory label (WRITE_OWNER or SeRelabelPrivilege is missing).' })
    }
    if ($runResult.restoreError) {
        [void]$failed.Add(@{ path = $root; message = $runResult.restoreError })
    }

    $removed = 0
    if ($removeAces) {
        foreach ($hit in @($record.manifest.hits)) {
            if (-not ($hit.sandboxSid -or $hit.everyoneDeny)) { continue }
            $count = 0
            $err = $null
            $rc = [Wi]::RemoveAces((ConvertTo-LongPath $hit.path), [bool]$hit.everyoneDeny, [ref]$count, [ref]$err)
            if ($rc -eq 0) { $removed += $count }
            else { [void]$failed.Add(@{ path = $hit.path; message = $err }) }
        }
    }

    $verify = $null
    if (-not $fast) {
        $verify = Invoke-Scan $root $allFiles $maxObjects
    } else {
        $rootInfo = Get-Info $root
        $verify = [pscustomobject]@{ low = $(if ($rootInfo.low) { 1 } else { 0 }); sandboxSid = 0; unreadable = 0 }
    }

    $rootInfo = Get-Info $root
    $fixNote = if (-not $runResult.ok) {
        'The root label could not be changed: the account lacks WRITE_OWNER and SeRelabelPrivilege; run from an administrator shell.'
    } elseif (-not $rootInfo.readable) {
        'The mandatory label could not be read back, so the repair cannot be verified; inspect the root with icacls from a normal shell.'
    } else {
        $null
    }
    return [pscustomobject]@{
        ok = ($rootInfo.readable -and (-not $rootInfo.low) -and (@($failed).Count -eq 0))
        action = 'fix'
        path = $root
        backupDir = $record.dir
        labelReadable = [bool]$rootInfo.readable
        low = [int]$verify.low
        sandboxSid = [int]$verify.sandboxSid
        unreadable = [int]$verify.unreadable
        labelsFixed = $(if ($rootInfo.readable -and -not $rootInfo.low) { 1 } else { 0 })
        removedAces = [int]$removed
        failed = @($failed)
        note = $fixNote
        elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds
    }
}

function Invoke-Rollback([string]$dir) {
    $manifestPath = Join-Path $dir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { throw "No manifest.json in $dir" }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $root = [string]$manifest.root
    $failed = New-Object System.Collections.ArrayList
    $restored = 0
    # An automatic record has no pre-scan, so its hit list cannot say what was
    # Low; `restored` then counts only the DACL and the label change.
    $preScanned = -not [bool]$manifest.fast

    if ($manifest.sddl) {
        $err = $null
        $rc = [Wi]::RestoreSddl((ConvertTo-LongPath $root), [string]$manifest.sddl, [ref]$err)
        if ($rc -eq 0) { $restored++ } else { [void]$failed.Add(@{ path = $root; message = "DACL: $err" }) }
    }

    foreach ($hit in @($manifest.hits)) {
        if ($null -eq $hit) { continue }
        if (-not $hit.low) { continue }
        $restored++
    }
    if ($manifest.rootLabel -eq 'Low') {
        $labelRun = Set-LabelTree $root '(OI)(CI)L'
        if ($labelRun.ok) { $restored++ }
        else { [void]$failed.Add(@{ path = $root; message = 'could not restore the Low label on the tree.' }) }
        if ($labelRun.restoreError) { [void]$failed.Add(@{ path = $root; message = $labelRun.restoreError }) }
    }

    return [pscustomobject]@{
        ok = (@($failed).Count -eq 0)
        action = 'rollback'
        path = $root
        backupDir = $dir
        restored = $restored
        preScanned = $preScanned
        failed = @($failed)
        note = $(if ($preScanned) { $null } else { 'This record came from an automatic cleanup, which does not pre-scan: restored counts only the root DACL and the label change.' })
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
                # A fast record has no pre-scan: "0 Low" would be a claim the
                # record cannot back up, so report null and let the panel say it
                # was an automatic cleanup instead.
                low = $(if ($fast) { $null } else { @($manifest.hits | Where-Object { $_.low }).Count })
                fast = $fast
                trigger = [string]$manifest.trigger
            })
        } catch { }
    }
    return @($items | Sort-Object { $_.createdAt } -Descending)
}

try {
    switch ($Action) {
        'records' {
            $obj = [ordered]@{ ok = $true; action = 'records'; records = @(Get-Records); elapsedMs = [int]((Get-Date) - $script:Start).TotalMilliseconds }
        }
        'rollback' {
            if (-not $BackupDir) { throw 'rollback needs -BackupDir' }
            $obj = Invoke-Rollback $BackupDir
        }
        default {
            if (-not $Path) { throw "$Action needs -Path" }
            if (-not (Test-Path -LiteralPath $Path)) { throw "Path does not exist: $Path" }
            $root = (Resolve-Path -LiteralPath $Path).ProviderPath
            if ($Action -eq 'scan') {
                $scan = Invoke-Scan $root ([bool]$AllFiles) $MaxObjects
                $obj = [ordered]@{
                    ok = $true
                    action = 'scan'
                    path = $root
                    dirs = $scan.dirs
                    files = $scan.files
                    low = $scan.low
                    sandboxSid = $scan.sandboxSid
                    unreadable = $scan.unreadable
                    unreadableSamples = $scan.unreadableSamples
                    truncated = $scan.truncated
                    hits = @($scan.hits | Select-Object -First 500)
                    failed = @()
                    elapsedMs = $scan.elapsedMs
                }
            } elseif ($Action -eq 'verify') {
                $scan = Invoke-Scan $root ([bool]$AllFiles) $MaxObjects
                $obj = [ordered]@{
                    ok = ($scan.low -eq 0)
                    action = 'verify'
                    path = $root
                    low = $scan.low
                    sandboxSid = $scan.sandboxSid
                    unreadable = $scan.unreadable
                    truncated = $scan.truncated
                    hits = @($scan.hits | Select-Object -First 500)
                    failed = @()
                    elapsedMs = $scan.elapsedMs
                }
            } else {
                $obj = Invoke-Fix $root ([bool]$RemoveAces) ([bool]$AllFiles) ([bool]$Fast) $MaxObjects $Trigger
            }
        }
    }
    [Console]::Out.WriteLine(($obj | ConvertTo-Json -Depth 10))
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    if ($Json) {
        [Console]::Out.WriteLine(([ordered]@{ ok = $false; action = $Action; error = $_.Exception.Message } | ConvertTo-Json -Depth 6))
    }
    exit 1
}
