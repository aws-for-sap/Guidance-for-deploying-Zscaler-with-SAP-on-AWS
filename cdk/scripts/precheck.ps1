<#
.SYNOPSIS
    ZPA Connector CDK — pre-deployment prerequisite check (Windows / PowerShell).
    Validates the prerequisites the CDK app does NOT create, and SUGGESTS a VPC
    and key pair to use. Read-only: it changes nothing.

.EXAMPLE
    .\precheck.ps1 -Profile my-profile -Region us-east-1
    .\precheck.ps1 -Profile my-profile -Region us-east-1 -Vpc vpc-123 -Subnets "subnet-a,subnet-b"

.NOTES
    Exit code 0 = all required checks passed; non-zero = at least one failed.
#>
param(
    [Parameter(Mandatory=$true)][string]$Profile,
    [Parameter(Mandatory=$true)][string]$Region,
    [string]$Vpc,
    [string]$Subnets,
    [string]$Secret = "zpa-connector",
    [string]$ProductCode = "by1wc5269g0048ix2nqvr0362"
)

$script:Pass = 0
$script:Fail = 0
function Ok($m)   { Write-Host "  [PASS] $m" -ForegroundColor Green;  $script:Pass++ }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red;    $script:Fail++ }
function Info($m) { Write-Host "  [INFO] $m" -ForegroundColor Yellow }

$AWS = @("--profile", $Profile, "--region", $Region)

Write-Host "== ZPA pre-deployment check =="
Write-Host "Profile: $Profile  Region: $Region`n"

# 0. Identity
Write-Host "0. Identity"
$acc = aws @AWS sts get-caller-identity --query Account --output text 2>$null
if ($LASTEXITCODE -eq 0 -and $acc) { Ok "Authenticated to account $acc" }
else { Bad "Cannot authenticate - run 'aws sso login' / configure the profile"; Write-Host "`nRESULT: FAIL (cannot continue)"; exit 1 }
Write-Host ""

# 1. Marketplace subscription for the Zscaler ZPA AMI
#    NOTE: AMI *visibility* (ec2 describe-images) does NOT prove the subscription is
#    accepted - a public Marketplace AMI is visible before you accept its terms, so
#    that check gives a false PASS. The authoritative read-only signal is the
#    Marketplace entitlement API. There is NO API to ACCEPT the terms - that is a
#    console-only click-through (a legal EULA); this script can only detect/warn.
Write-Host "1. Zscaler ZPA Marketplace subscription ($ProductCode)"
$subUrl = "https://aws.amazon.com/marketplace/pp?sku=$ProductCode"
$ent = aws @AWS marketplace-entitlement get-entitlements --product-code $ProductCode --query 'length(Entitlements)' --output text 2>$null
$amiCount = aws @AWS ec2 describe-images --filters "Name=product-code,Values=$ProductCode" "Name=state,Values=available" --query 'length(Images)' --output text 2>$null
if ($LASTEXITCODE -eq 0 -and $ent -and [int]$ent -gt 0) {
    Ok "Marketplace entitlement present - subscription accepted."
} elseif ($amiCount -and [int]$amiCount -gt 0) {
    # Free/BYOL product: entitlements stay empty even when subscribed, so we cannot
    # PROVE acceptance read-only. Warn rather than pass - this is the gate that fails
    # the ASG at deploy time with 'you need to accept terms and subscribe'.
    Info "AMI is visible but this is a free/BYOL product, so the subscription cannot be confirmed via API."
    Info "If 'cdk deploy' fails on the ASG with 'accept terms and subscribe', subscribe once (free) at:"
    Info "  $subUrl"
    Info "Log into the AWS console for THIS account, then Continue to Subscribe -> Accept Terms."
} else {
    Bad "No ZPA AMI visible and no entitlement - accept the Zscaler ZPA subscription (once, free) at: $subUrl"
}
Write-Host ""

# 2. VPC
Write-Host "2. VPC"
if (-not $Vpc) {
    Info "No -Vpc supplied; candidate VPCs in this account/region:"
    aws @AWS ec2 describe-vpcs --query 'Vpcs[].{VpcId:VpcId,CIDR:CidrBlock,Default:IsDefault,Name:Tags[?Key==`Name`]|[0].Value}' --output table
    Info "Re-run with -Vpc <vpc-id> to validate DNS + subnets."
} else {
    $dnsSup  = aws @AWS ec2 describe-vpc-attribute --vpc-id $Vpc --attribute enableDnsSupport   --query 'EnableDnsSupport.Value'   --output text 2>$null
    $dnsHost = aws @AWS ec2 describe-vpc-attribute --vpc-id $Vpc --attribute enableDnsHostnames --query 'EnableDnsHostnames.Value' --output text 2>$null
    if ($dnsSup  -eq "True") { Ok "enableDnsSupport = true" }   else { Bad "enableDnsSupport is not true" }
    if ($dnsHost -eq "True") { Ok "enableDnsHostnames = true" } else { Bad "enableDnsHostnames is not true" }
}
Write-Host ""

# 3. Private subnets
Write-Host "3. Private subnets"
if (-not $Subnets) {
    if ($Vpc) {
        Info "No -Subnets supplied; private-looking subnets in $Vpc :"
        aws @AWS ec2 describe-subnets --filters "Name=vpc-id,Values=$Vpc" `
            --query 'Subnets[?MapPublicIpOnLaunch==`false`].{SubnetId:SubnetId,AZ:AvailabilityZone,CIDR:CidrBlock,Name:Tags[?Key==`Name`]|[0].Value}' --output table
    }
    Info "Re-run with -Subnets 'a,b' (two private subnets in two AZs) to validate."
} else {
    $parts = $Subnets.Split(",").Trim()
    $azs = aws @AWS ec2 describe-subnets --subnet-ids $parts --query 'Subnets[].AvailabilityZone' --output text 2>$null
    $uniq = ($azs -split "\s+" | Sort-Object -Unique).Count
    if ($uniq -eq 2) { Ok "Subnets are in 2 distinct AZs ($azs)" } else { Bad "Subnets are not in 2 distinct AZs ($azs)" }
    foreach ($s in $parts) {
        $nat = aws @AWS ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$s" `
            --query 'RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`].NatGatewayId' --output text 2>$null
        if ($nat -and $nat -ne "None") { Ok "$s has default route via NAT ($nat)" } else { Bad "$s has no NAT default route (outbound internet required)" }
    }
}
Write-Host ""

# 4. NAT gateways
Write-Host "4. NAT gateways"
if ($Vpc) {
    $nats = aws @AWS ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$Vpc" --query 'NatGateways[?State==`available`].NatGatewayId' --output text 2>$null
    if ($nats) { Ok "Available NAT gateway(s): $nats" } else { Bad "No available NAT gateway in $Vpc" }
} else { Info "Skipped (no -Vpc)." }
Write-Host ""

# 5. Key pair
Write-Host "5. Key pair (optional - default admin path is SSM Session Manager)"
$keys = aws @AWS ec2 describe-key-pairs --query 'KeyPairs[].KeyName' --output text 2>$null
if ($keys) { Info "Existing key pairs: $keys" } else { Info "No key pairs (fine - SSM Session Manager needs none)." }
Write-Host ""

# 6. Secret
Write-Host "6. Secrets Manager secret '$Secret'"
$arn = aws @AWS secretsmanager describe-secret --secret-id $Secret --query ARN --output text 2>$null
if ($LASTEXITCODE -eq 0 -and $arn) {
    Ok "Secret exists: $arn"
    Info "The CDK stack manages this secret; ensure its value is the real provisioning key (not the placeholder)."
} else {
    Info "Secret does not exist yet - the CDK stack will CREATE it empty; populate it after deploy:"
    Info "  aws --profile $Profile --region $Region secretsmanager put-secret-value --secret-id $Secret --secret-string '<PROVISIONING_KEY>'"
}
Write-Host ""

# 7. EC2 Auto Scaling service-linked role (needed by the default customer-managed CMK)
#    The CMK key policy names AWSServiceRoleForAutoScaling so the ASG can launch
#    connectors with CMK-encrypted root volumes. KMS rejects a key policy that names a
#    role that does not exist yet, so in a brand-new account create it once first.
Write-Host "7. EC2 Auto Scaling service-linked role"
$slr = aws @AWS iam get-role --role-name AWSServiceRoleForAutoScaling --query Role.Arn --output text 2>$null
if ($LASTEXITCODE -eq 0 -and $slr) {
    Ok "Service-linked role exists: $slr"
} else {
    Bad "AWSServiceRoleForAutoScaling not found (required with the defaults: encryptionKeyType=customer-managed or enableAlarms=true). Create it once:"
    Info "  aws --profile $Profile iam create-service-linked-role --aws-service-name autoscaling.amazonaws.com"
}
Write-Host ""

Write-Host "== RESULT: $script:Pass passed, $script:Fail failed =="
if ($script:Fail -eq 0) { Write-Host "All required checks passed. Safe to cdk deploy." -ForegroundColor Green; exit 0 }
else { Write-Host "Fix the FAIL items before deploying." -ForegroundColor Red; exit 1 }
