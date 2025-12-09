# Backup PowerShell Script for Project
# This script creates a backup of the current project directory into a 'backups' folder
# The backup folder will be named with the current date and time

# Get the current script directory
$projectPath = Split-Path -Parent $MyInvocation.MyCommand.Definition

# Set the backup root directory
$backupRoot = Join-Path $projectPath 'backups'

# Create the backup directory if it doesn't exist
if (!(Test-Path $backupRoot)) {
    New-Item -ItemType Directory -Path $backupRoot | Out-Null
}

# Create a timestamp for the backup folder
$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupFolder = Join-Path $backupRoot "sae-$timestamp"

# Copy the project directory to the backup folder, excluding the backups folder itself
Write-Host "Backing up project to $backupFolder ..."


# Exclude the 'backups' and 'cache' folders from the copy
$exclude = @("backups", "cache")

Get-ChildItem -Path $projectPath -Exclude $exclude | ForEach-Object {
    $dest = Join-Path $backupFolder $_.Name
    if ($_.PSIsContainer) {
        Copy-Item $_.FullName -Destination $dest -Recurse
    } else {
        Copy-Item $_.FullName -Destination $backupFolder
    }
}


# Copia lo script di backup nella cartella di backup
$scriptName = Split-Path -Leaf $MyInvocation.MyCommand.Definition
Copy-Item -Path (Join-Path $projectPath $scriptName) -Destination $backupFolder -Force

Write-Host "Backup completed successfully!"
