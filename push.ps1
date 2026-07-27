<#
.SYNOPSIS
Builds the web app and publishes it to a Dataverse web resource.

.DESCRIPTION
Runs `npm run build` in the project, uploads the generated dist/index.html to an
existing Dataverse web resource, and publishes it. Signs in interactively and
supports -WhatIf for safe dry runs. Read-only until the update/publish steps,
which are guarded by ShouldProcess.

.PARAMETER EnvironmentUrl
The Dataverse environment URL, e.g. https://contoso.crm.dynamics.com

.PARAMETER WebResourceName
Logical name of the web resource to update, e.g. new_myapp/index.html

.PARAMETER ProjectPath
Path to the project root containing package.json and the dist output.

.PARAMETER SkipBuild
Skip `npm run build` and upload the existing dist/index.html.

.PARAMETER TenantId
Optional tenant (GUID or domain) to sign in against. Defaults to the account's
home tenant.

.EXAMPLE
.\Publish-DataverseWebResource.ps1 -EnvironmentUrl https://contoso.crm.dynamics.com `
    -WebResourceName new_myapp/index.html -ProjectPath C:\repos\myapp -WhatIf

.PREREQUISITES
MSAL.PS module and an npm-based build. Sign in with an account that has access
to the target Dataverse environment.
#>
#Requires -Modules MSAL.PS
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()]
    [string]$EnvironmentUrl,

    [Parameter(Mandatory)][ValidateNotNullOrEmpty()]
    [string]$WebResourceName,

    [Parameter(Mandatory)][ValidateNotNullOrEmpty()]
    [string]$ProjectPath,

    [switch]$SkipBuild,

    [string]$TenantId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Azure CLI public client id — supports interactive/MFA sign-in with no app registration.
$clientId = '04b07795-8ddb-461a-bbee-02f9e7b1bf6b'
$baseUrl  = $EnvironmentUrl.TrimEnd('/')
$apiUrl   = "$baseUrl/api/data/v9.2"

# 1. Build
$indexPath = Join-Path $ProjectPath 'dist/index.html'
if (-not $SkipBuild) {
    if ($PSCmdlet.ShouldProcess($ProjectPath, 'npm run build')) {
        Push-Location $ProjectPath
        try {
            npm run build
            if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
        }
        finally { Pop-Location }
    }
}

if (-not (Test-Path $indexPath)) {
    if ($WhatIfPreference) {
        Write-Host "WhatIf: would upload and publish '$WebResourceName' from $indexPath"
        return
    }
    throw "Built file not found: $indexPath"
}

$content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content $indexPath -Raw)))

# 2. Sign in
Write-Host 'Signing in...'
$tokenArgs = @{ ClientId = $clientId; Interactive = $true; Scopes = @("$baseUrl/.default") }
if ($TenantId) { $tokenArgs.TenantId = $TenantId }
$token = Get-MsalToken @tokenArgs

$headers = @{
    Authorization    = "Bearer $($token.AccessToken)"
    'Content-Type'   = 'application/json'
    'OData-Version'  = '4.0'
    Accept           = 'application/json'
}

# 3. Look up the web resource
$name = $WebResourceName.Replace("'", "''")
$lookup = Invoke-RestMethod -Method Get -Headers $headers `
    -Uri "$apiUrl/webresourceset?`$select=webresourceid&`$filter=name eq '$name'"
if ($lookup.value.Count -eq 0) { throw "Web resource not found: $WebResourceName" }
$id = $lookup.value[0].webresourceid

# 4. Update content
if ($PSCmdlet.ShouldProcess($WebResourceName, 'Update web resource content')) {
    Invoke-RestMethod -Method Patch -Headers $headers `
        -Uri "$apiUrl/webresourceset($id)" `
        -Body (@{ content = $content } | ConvertTo-Json)
    Write-Host "Updated $WebResourceName"
}

# 5. Publish
if ($PSCmdlet.ShouldProcess($WebResourceName, 'Publish web resource')) {
    $body = @{ ParameterXml = "<importexportxml><webresources><webresource>$id</webresource></webresources></importexportxml>" }
    Invoke-RestMethod -Method Post -Headers $headers `
        -Uri "$apiUrl/PublishXml" -Body ($body | ConvertTo-Json)
    Write-Host "Published $WebResourceName"
}