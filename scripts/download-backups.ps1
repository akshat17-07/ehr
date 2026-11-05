<#
Hospital PC: download the encrypted backup and audit exports (read-only AWS user) into one persistent mirror.
Usage:  powershell -File download-backups.ps1 -Stage prod -BackupBucket ehr-prod-backup-<account> -Root D:\EHR-Backups
Needs the AWS CLI and a profile named ehr-<stage>-hospital-pc (see docs/india/pc-backup-guide.md).
Syncs backup/<stage>/ and audit/<stage>/ into <Root>\mirror\{backup,audit}\<stage>. Each run only downloads what is new.
Files that are new or changed in this run are checked against the S3 listing (size, and MD5 when the ETag is a plain MD5).
Appends one line to <Root>\download.log (date, stage, files, bytes, new files, OK/FAIL). Never deletes anything.
Exit code 0 = OK, 1 = FAIL.
#>
param(
  [Parameter(Mandatory)][string]$Stage,
  [Parameter(Mandatory)][string]$BackupBucket,
  [string]$Root = 'D:\EHR-Backups',
  [string]$AwsProfile = "ehr-$Stage-hospital-pc",
  [string]$Region = 'ap-south-1'
)
$ErrorActionPreference = 'Stop'
$log = Join-Path $Root 'download.log'
$files = 0; $bytes = 0L; $new = 0; $status = 'OK'; $note = ''
try {
  New-Item -ItemType Directory -Force -Path $Root | Out-Null
  foreach ($kind in 'backup', 'audit') {
    $target = Join-Path (Join-Path (Join-Path $Root 'mirror') $kind) $Stage
    New-Item -ItemType Directory -Force -Path $target | Out-Null

    # Snapshot before: path -> "length|last write ticks".
    $before = @{}
    Get-ChildItem -Path $target -Recurse -File | ForEach-Object { $before[$_.FullName] = "$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }

    # Sync only copies; without --delete nothing local is ever removed.
    & aws s3 sync "s3://$BackupBucket/$kind/$Stage/" $target --profile $AwsProfile --region $Region --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "aws s3 sync failed for $kind/$Stage/" }

    $json = & aws s3api list-objects-v2 --bucket $BackupBucket --prefix "$kind/$Stage/" --profile $AwsProfile --region $Region --output json
    if ($LASTEXITCODE -ne 0) { throw "aws list failed for $kind/$Stage/" }
    $list = ($json | Out-String | ConvertFrom-Json).Contents
    foreach ($o in $list) {
      if ($o.Key.EndsWith('/')) { continue }
      $rel = $o.Key.Substring("$kind/$Stage/".Length).Replace('/', '\')
      $local = Join-Path $target $rel
      if (-not (Test-Path $local)) { throw "missing $($o.Key)" }
      $item = Get-Item $local
      $stamp = "$($item.Length)|$($item.LastWriteTimeUtc.Ticks)"
      if ($before[$item.FullName] -ne $stamp) {   # new or changed in this run
        $new++
        if ($item.Length -ne $o.Size) { throw "size mismatch $($o.Key): local $($item.Length) vs S3 $($o.Size)" }
        $etag = $o.ETag.Trim('"')
        if ($etag -notmatch '-') {   # single-part upload: ETag is the MD5
          if ((Get-FileHash $local -Algorithm MD5).Hash.ToLower() -ne $etag.ToLower()) { throw "hash mismatch $($o.Key)" }
        }
      }
      $files++; $bytes += $item.Length
    }
  }
} catch {
  $status = 'FAIL'; $note = " $($_.Exception.Message)"
}
$line = "{0} stage={1} files={2} bytes={3} new={4} {5}{6}" -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz'), $Stage, $files, $bytes, $new, $status, $note
Add-Content -Path $log -Value $line
Write-Output $line
if ($status -eq 'OK') { exit 0 } else { exit 1 }
