# Shared by the build entry points. Never interpolate an unchecked origin into
# linker flags; it must be a plain HTTPS authority, not a command or URL path.
function ConvertTo-WailsBuildOrigin([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    $Value = $Value.Trim()
    if ($Value -notmatch '^https://[A-Za-z0-9.\-\[\]:]+/?$') {
        throw 'The packaged API origin must be HTTPS with only a host and optional port.'
    }
    $parsed = $null
    if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed) -or
        $parsed.Scheme -ne 'https' -or -not $parsed.Host -or
        $parsed.HostNameType -eq [UriHostNameType]::Unknown -or
        $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment -or
        $parsed.AbsolutePath -ne '/') {
        throw 'The packaged API origin must be HTTPS with only a host and optional port.'
    }
    return $parsed.GetLeftPart([UriPartial]::Authority).ToLowerInvariant()
}
