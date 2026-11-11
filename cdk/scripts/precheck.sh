#!/usr/bin/env bash
# shellcheck disable=SC2016  # the backticks are JMESPath literals inside --query strings, not shell expansions
# ============================================================================
# ZPA Connector CDK — pre-deployment prerequisite check (Linux / macOS / Cloud Shell)
#
# Validates the prerequisites the CDK app does NOT create, and SUGGESTS a VPC
# and key pair to use. Read-only: it changes nothing.
#
# Usage:
#   ./precheck.sh --profile <aws-profile> --region <region> \
#                 [--vpc <vpc-id>] [--subnets <subnet-a,subnet-b>] \
#                 [--secret <name>] [--product-code <code>]
#
# Exit code 0 = all required checks passed; non-zero = at least one failed.
# ============================================================================
set -uo pipefail

PROFILE=""; REGION=""; VPC=""; SUBNETS=""
SECRET="zpa-connector"
PRODUCT_CODE="by1wc5269g0048ix2nqvr0362"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --vpc) VPC="$2"; shift 2;;
    --subnets) SUBNETS="$2"; shift 2;;
    --secret) SECRET="$2"; shift 2;;
    --product-code) PRODUCT_CODE="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 2;;
  esac
done

if [[ -z "$PROFILE" || -z "$REGION" ]]; then
  echo "ERROR: --profile and --region are required." >&2
  exit 2
fi

AWS=(aws --profile "$PROFILE" --region "$REGION")
PASS=0; FAIL=0
ok()   { echo "  [PASS] $*"; PASS=$((PASS+1)); }
bad()  { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }
info() { echo "  [INFO] $*"; }

echo "== ZPA pre-deployment check =="
echo "Profile: $PROFILE  Region: $REGION"
echo

# 0. Credentials
echo "0. Identity"
if ACC=$("${AWS[@]}" sts get-caller-identity --query Account --output text 2>/dev/null); then
  ok "Authenticated to account $ACC"
else
  bad "Cannot authenticate — run 'aws sso login' / configure the profile"
  echo; echo "RESULT: FAIL (cannot continue)"; exit 1
fi
echo

# 1. Marketplace subscription for the Zscaler ZPA AMI
#    NOTE: AMI *visibility* (ec2 describe-images) does NOT prove the subscription is
#    accepted - a public Marketplace AMI is visible before you accept its terms, so
#    that check gives a false PASS. The authoritative read-only signal is the
#    Marketplace entitlement API. There is NO API to ACCEPT the terms - that is a
#    console-only click-through (a legal EULA); this script can only detect/warn.
echo "1. Zscaler ZPA Marketplace subscription ($PRODUCT_CODE)"
SUB_URL="https://aws.amazon.com/marketplace/pp?sku=$PRODUCT_CODE"
ENT=$("${AWS[@]}" marketplace-entitlement get-entitlements --product-code "$PRODUCT_CODE" --query 'length(Entitlements)' --output text 2>/dev/null)
AMI_COUNT=$("${AWS[@]}" ec2 describe-images --filters "Name=product-code,Values=$PRODUCT_CODE" "Name=state,Values=available" --query 'length(Images)' --output text 2>/dev/null)
if [[ -n "$ENT" && "$ENT" =~ ^[0-9]+$ && "$ENT" -gt 0 ]]; then
  ok "Marketplace entitlement present - subscription accepted."
elif [[ -n "$AMI_COUNT" && "$AMI_COUNT" =~ ^[0-9]+$ && "$AMI_COUNT" -gt 0 ]]; then
  # Free/BYOL product: entitlements stay empty even when subscribed, so we cannot
  # PROVE acceptance read-only. Warn rather than pass - this is the gate that fails
  # the ASG at deploy time with 'you need to accept terms and subscribe'.
  info "AMI is visible but this is a free/BYOL product, so the subscription cannot be confirmed via API."
  info "If 'cdk deploy' fails on the ASG with 'accept terms and subscribe', subscribe once (free) at:"
  info "  $SUB_URL"
  info "Log into the AWS console for THIS account, then Continue to Subscribe -> Accept Terms."
else
  bad "No ZPA AMI visible and no entitlement - accept the Zscaler ZPA subscription (once, free) at: $SUB_URL"
fi
echo

# 2. Suggest a VPC if none given
echo "2. VPC"
if [[ -z "$VPC" ]]; then
  info "No --vpc supplied; candidate VPCs in this account/region:"
  "${AWS[@]}" ec2 describe-vpcs \
    --query 'Vpcs[].{VpcId:VpcId,CIDR:CidrBlock,Default:IsDefault,Name:Tags[?Key==`Name`]|[0].Value}' \
    --output table
  info "Re-run with --vpc <vpc-id> to validate DNS + subnets."
else
  DNS_SUP=$("${AWS[@]}" ec2 describe-vpc-attribute --vpc-id "$VPC" --attribute enableDnsSupport   --query 'EnableDnsSupport.Value'   --output text 2>/dev/null)
  DNS_HOST=$("${AWS[@]}" ec2 describe-vpc-attribute --vpc-id "$VPC" --attribute enableDnsHostnames --query 'EnableDnsHostnames.Value' --output text 2>/dev/null)
  if [[ "$DNS_SUP" == "True" ]];  then ok "enableDnsSupport = true";   else bad "enableDnsSupport is not true"; fi
  if [[ "$DNS_HOST" == "True" ]]; then ok "enableDnsHostnames = true"; else bad "enableDnsHostnames is not true"; fi
fi
echo

# 3. Subnets: two, different AZs, each with a default route to a NAT gateway
#    (regional or zonal) or to a transit gateway (centralized egress VPC)
echo "3. Private subnets"
EGRESS_TGW=0
if [[ -z "$SUBNETS" ]]; then
  if [[ -n "$VPC" ]]; then
    info "No --subnets supplied; private-looking subnets in $VPC (no public IP on launch):"
    "${AWS[@]}" ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC" \
      --query 'Subnets[?MapPublicIpOnLaunch==`false`].{SubnetId:SubnetId,AZ:AvailabilityZone,CIDR:CidrBlock,Name:Tags[?Key==`Name`]|[0].Value}' \
      --output table
  fi
  info "Re-run with --subnets <a,b> (two private subnets in two AZs) to validate."
else
  IFS=',' read -r S1 S2 <<< "$SUBNETS"
  AZS=$("${AWS[@]}" ec2 describe-subnets --subnet-ids "$S1" "$S2" --query 'Subnets[].AvailabilityZone' --output text 2>/dev/null)
  UNIQ=$(echo "$AZS" | tr '\t' '\n' | sort -u | wc -l | tr -d ' ')
  if [[ "$UNIQ" == "2" ]]; then ok "Subnets are in 2 distinct AZs ($AZS)"; else bad "Subnets are not in 2 distinct AZs ($AZS)"; fi
  for S in "$S1" "$S2"; do
    RT=$("${AWS[@]}" ec2 describe-route-tables --filters "Name=association.subnet-id,Values=$S" \
      --query 'RouteTables[].Routes[?DestinationCidrBlock==`0.0.0.0/0`].[NatGatewayId,TransitGatewayId]' --output text 2>/dev/null)
    NAT=$(grep -o 'nat-[0-9a-f]*' <<< "$RT" | head -n1)
    TGW=$(grep -o 'tgw-[0-9a-f]*' <<< "$RT" | head -n1)
    if [[ -n "$NAT" ]]; then ok "$S has default route via NAT gateway ($NAT)"
    elif [[ -n "$TGW" ]]; then ok "$S has default route via transit gateway ($TGW, centralized egress)"; EGRESS_TGW=1
    else bad "$S has no default route to a NAT gateway or transit gateway (outbound internet required)"; fi
  done
fi
echo

# 4. NAT gateways available
echo "4. NAT gateways"
if [[ -n "$VPC" ]]; then
  NATS=$("${AWS[@]}" ec2 describe-nat-gateways --filter "Name=vpc-id,Values=$VPC" \
    --query 'NatGateways[?State==`available`].NatGatewayId' --output text 2>/dev/null)
  if [[ -n "$NATS" ]]; then ok "Available NAT gateway(s): $NATS"
  elif [[ "$EGRESS_TGW" == "1" ]]; then info "No NAT gateway in $VPC; the subnets use a centralized egress VPC. Confirm it allows outbound TCP 80 and 443."
  else bad "No available NAT gateway in $VPC"; fi
else
  info "Skipped (no --vpc)."
fi
echo

# 5. Key pair (suggest one — only needed if you choose SSH admin; default is SSM)
echo "5. Key pair (optional — default admin path is SSM Session Manager)"
KEYS=$("${AWS[@]}" ec2 describe-key-pairs --query 'KeyPairs[].KeyName' --output text 2>/dev/null)
if [[ -n "$KEYS" ]]; then info "Existing key pairs: $KEYS"; else info "No key pairs (fine — SSM Session Manager needs none)."; fi
echo

# 6. Secret existence
echo "6. Secrets Manager secret '$SECRET'"
if ARN=$("${AWS[@]}" secretsmanager describe-secret --secret-id "$SECRET" --query ARN --output text 2>/dev/null); then
  ok "Secret exists: $ARN"
  info "The CDK stack manages this secret; ensure its value is the real provisioning key (not the placeholder)."
else
  info "Secret does not exist yet — the CDK stack will CREATE it empty; populate it after deploy:"
  info "  Save the key to provisioning-key.txt with an editor (not on the command line), then:"
  info "  aws --profile $PROFILE --region $REGION secretsmanager put-secret-value --secret-id $SECRET --secret-string file://provisioning-key.txt && shred -u provisioning-key.txt"
fi
echo

# 7. EC2 Auto Scaling service-linked role (needed by the default customer-managed CMK)
#    The CMK key policy names AWSServiceRoleForAutoScaling so the ASG can launch
#    connectors with CMK-encrypted root volumes. KMS rejects a key policy that names a
#    role that does not exist yet, so in a brand-new account create it once first.
echo "7. EC2 Auto Scaling service-linked role"
if SLR=$("${AWS[@]}" iam get-role --role-name AWSServiceRoleForAutoScaling --query Role.Arn --output text 2>/dev/null); then
  ok "Service-linked role exists: $SLR"
else
  bad "AWSServiceRoleForAutoScaling not found (required with the defaults: encryptionKeyType=customer-managed or enableAlarms=true). Create it once:"
  info "  aws --profile $PROFILE iam create-service-linked-role --aws-service-name autoscaling.amazonaws.com"
fi
echo

echo "== RESULT: $PASS passed, $FAIL failed =="
if [[ "$FAIL" -eq 0 ]]; then echo "All required checks passed. Safe to cdk deploy."; exit 0; else echo "Fix the FAIL items before deploying."; exit 1; fi
