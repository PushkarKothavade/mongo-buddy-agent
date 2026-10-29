#!/usr/bin/env bash
# Create a static egress path for the AgentCore runtime:
# public subnet + NAT Gateway + Elastic IP, private subnet routed through the NAT.
# Run from anywhere: bash scripts/setup-agentcore-network.sh
set -uo pipefail

export AWS_DEFAULT_REGION=ap-south-1
export AWS_PAGER=""

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/agentcore/agentcore.json"

step() {
  printf '\n======== %s ========\n' "$1"
}

run() {
  printf '+ %s\n' "$*"
  if "$@"; then
    printf 'OK\n'
  else
    local status=$?
    printf 'FAILED (exit %s)\n' "$status" >&2
    exit "$status"
  fi
}

capture() {
  local __var="$1"
  shift
  printf '+ %s\n' "$*"
  local output
  if output=$("$@"); then
    printf 'OK: %s=%s\n' "$__var" "$output"
    printf -v "$__var" '%s' "$output"
  else
    local status=$?
    printf 'FAILED (exit %s)\n' "$status" >&2
    exit "$status"
  fi
}

if ! command -v aws >/dev/null 2>&1; then
  printf 'FAILED: aws CLI is not on PATH\n' >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  printf 'FAILED: jq is not on PATH\n' >&2
  exit 1
fi
if [[ ! -f "$CONFIG" ]]; then
  printf 'FAILED: config not found: %s\n' "$CONFIG" >&2
  exit 1
fi

step "1. Pick an availability zone"
capture AZ aws ec2 describe-availability-zones \
  --filters Name=state,Values=available \
  --query 'AvailabilityZones[0].ZoneName' --output text

step "2. Create the VPC"
capture VPC_ID aws ec2 create-vpc \
  --cidr-block 10.20.0.0/16 \
  --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=mongo-buddy}]' \
  --query Vpc.VpcId --output text

step "3. Enable DNS hostnames"
run aws ec2 modify-vpc-attribute \
  --vpc-id "$VPC_ID" \
  --enable-dns-hostnames Value=true

step "4. Create and attach an internet gateway"
capture IGW_ID aws ec2 create-internet-gateway \
  --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=mongo-buddy}]' \
  --query InternetGateway.InternetGatewayId --output text
run aws ec2 attach-internet-gateway \
  --internet-gateway-id "$IGW_ID" \
  --vpc-id "$VPC_ID"

step "5. Create the public subnet"
capture PUBLIC_SUBNET aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block 10.20.1.0/24 \
  --availability-zone "$AZ" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=mongo-buddy-public}]' \
  --query Subnet.SubnetId --output text
run aws ec2 modify-subnet-attribute \
  --subnet-id "$PUBLIC_SUBNET" \
  --map-public-ip-on-launch

step "6. Create the private subnet"
capture PRIVATE_SUBNET aws ec2 create-subnet \
  --vpc-id "$VPC_ID" \
  --cidr-block 10.20.2.0/24 \
  --availability-zone "$AZ" \
  --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=mongo-buddy-private}]' \
  --query Subnet.SubnetId --output text

step "7. Public route table: 0.0.0.0/0 to the internet gateway"
capture PUBLIC_RT aws ec2 create-route-table \
  --vpc-id "$VPC_ID" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=mongo-buddy-public}]' \
  --query RouteTable.RouteTableId --output text
run aws ec2 create-route \
  --route-table-id "$PUBLIC_RT" \
  --destination-cidr-block 0.0.0.0/0 \
  --gateway-id "$IGW_ID"
run aws ec2 associate-route-table \
  --route-table-id "$PUBLIC_RT" \
  --subnet-id "$PUBLIC_SUBNET"

step "8. Allocate an Elastic IP"
capture ALLOC_ID aws ec2 allocate-address \
  --domain vpc \
  --tag-specifications 'ResourceType=elastic-ip,Tags=[{Key=Name,Value=mongo-buddy-nat}]' \
  --query AllocationId --output text
capture EIP aws ec2 describe-addresses \
  --allocation-ids "$ALLOC_ID" \
  --query 'Addresses[0].PublicIp' --output text

step "9. Create the NAT Gateway in the public subnet"
capture NAT_ID aws ec2 create-nat-gateway \
  --subnet-id "$PUBLIC_SUBNET" \
  --allocation-id "$ALLOC_ID" \
  --tag-specifications 'ResourceType=natgateway,Tags=[{Key=Name,Value=mongo-buddy}]' \
  --query NatGateway.NatGatewayId --output text
printf 'Waiting for NAT Gateway %s. This often takes 2 to 5 minutes.\n' "$NAT_ID"
run aws ec2 wait nat-gateway-available --nat-gateway-ids "$NAT_ID"

step "10. Private route table: 0.0.0.0/0 to the NAT Gateway"
capture PRIVATE_RT aws ec2 create-route-table \
  --vpc-id "$VPC_ID" \
  --tag-specifications 'ResourceType=route-table,Tags=[{Key=Name,Value=mongo-buddy-private}]' \
  --query RouteTable.RouteTableId --output text
run aws ec2 create-route \
  --route-table-id "$PRIVATE_RT" \
  --destination-cidr-block 0.0.0.0/0 \
  --nat-gateway-id "$NAT_ID"
run aws ec2 associate-route-table \
  --route-table-id "$PRIVATE_RT" \
  --subnet-id "$PRIVATE_SUBNET"

step "11. Security group: HTTPS out, DNS inside the VPC"
capture SG_ID aws ec2 create-security-group \
  --vpc-id "$VPC_ID" \
  --group-name mongo-buddy-runtime \
  --description "Mongo Buddy AgentCore egress" \
  --query GroupId --output text
run aws ec2 revoke-security-group-egress \
  --group-id "$SG_ID" \
  --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]'
run aws ec2 authorize-security-group-egress \
  --group-id "$SG_ID" \
  --ip-permissions '[
    {"IpProtocol":"tcp","FromPort":443,"ToPort":443,"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"HTTPS"}]},
    {"IpProtocol":"udp","FromPort":53,"ToPort":53,"IpRanges":[{"CidrIp":"10.20.0.0/16","Description":"DNS"}]},
    {"IpProtocol":"tcp","FromPort":53,"ToPort":53,"IpRanges":[{"CidrIp":"10.20.0.0/16","Description":"DNS"}]}
  ]'

step "12. Point the AgentCore runtime at the private subnet"
printf '+ jq update %s\n' "$CONFIG"
if jq --arg vpc "$VPC_ID" --arg subnet "$PRIVATE_SUBNET" --arg sg "$SG_ID" \
  '.runtimes[0].networkMode = "VPC"
   | .runtimes[0].networkConfig = {vpcId: $vpc, subnets: [$subnet], securityGroups: [$sg]}' \
  "$CONFIG" > "$CONFIG.tmp"; then
  mv "$CONFIG.tmp" "$CONFIG"
  printf 'OK: networkMode=VPC vpc=%s subnet=%s sg=%s\n' "$VPC_ID" "$PRIVATE_SUBNET" "$SG_ID"
else
  local_status=$?
  rm -f "$CONFIG.tmp"
  printf 'FAILED (exit %s): jq update\n' "$local_status" >&2
  exit "$local_status"
fi

printf '\n======== Done ========\n'
printf 'VPC:              %s\n' "$VPC_ID"
printf 'Public subnet:    %s\n' "$PUBLIC_SUBNET"
printf 'Private subnet:   %s\n' "$PRIVATE_SUBNET"
printf 'NAT Gateway:      %s\n' "$NAT_ID"
printf 'Security group:   %s\n' "$SG_ID"
printf 'Elastic IP:       %s/32\n' "$EIP"
printf 'Add that Elastic IP on the Atlas service account API access list, then run: agentcore deploy\n'
