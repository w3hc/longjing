# TEE Platform Deployment Guide

This guide provides step-by-step instructions for deploying Longjing to various Trusted Execution Environment (TEE) platforms.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Platform-Specific Setup](#platform-specific-setup)
  - [AMD SEV-SNP](#amd-sev-snp)
  - [Intel TDX](#intel-tdx)
  - [AWS Nitro Enclaves](#aws-nitro-enclaves)
  - [Phala Network (Intel TDX/SGX)](#phala-network-intel-tdxsgx)
- [General TEE Configuration](#general-tee-configuration)
- [Verification and Testing](#verification-and-testing)
- [Security Considerations](#security-considerations)
- [Troubleshooting](#troubleshooting)

## Prerequisites

Before deploying to any TEE platform, ensure you have:

1. **Built the application**:
   ```bash
   pnpm install
   pnpm build
   ```

2. **Docker installed** (recommended for production):
   ```bash
   docker --version
   ```

3. **Environment variables configured**:
   ```bash
   cp .env.template .env
   # Edit .env with production values
   PROFILE=prod
   NODE_ENV=production
   # No key material: keys are derived from the dstack KMS,
   # see KEY_DERIVATION.md
   ```

4. **TLS certificates ready**: In production, certificates should be generated inside the enclave to ensure the host never sees the private key.

## Secret Management

**Keys** (ML-KEM, refund signer, identity, TLS) are never secrets you manage: on dstack they are derived inside the enclave with `GetKey`, and production refuses to start with `ADMIN_MLKEM_PRIVATE_KEY`, `OPERATOR_PRIVATE_KEY`, `TLS_KEY_PATH` or `TLS_CERT_PATH` in env. See [KEY_DERIVATION.md](KEY_DERIVATION.md), including the `ALLOW_KEYS_OUTSIDE_ENCLAVE` opt-out.

**Attestation** in production goes only through dstack. The server refuses to start without `/var/run/dstack.sock`, with `DSTACK_SIMULATOR_ENDPOINT` set, or with `TEE_PLATFORM` set to anything but `auto` or `phala`, and it checks that a first quote carries the requested `report_data` before serving.

The strategies below apply to the remaining secrets, such as `ANTHROPIC_API_KEY`.

### Strategy 1: KMS with TEE Attestation (Most Secure)

**Use when**: Deploying to cloud TEE (AWS Nitro, Azure Confidential VMs, etc.)

```bash
PROFILE=prod
NODE_ENV=production
KMS_URL=https://kms.your-domain.com/secrets
```

The application will:
1. Generate TEE attestation report proving its identity
2. Send attestation to KMS endpoint
3. KMS verifies attestation and releases secrets
4. Secrets loaded into memory only

**KMS Implementation**: You need to provide a KMS service that:
- Accepts POST requests with attestation reports
- Verifies the attestation against expected measurements
- Returns secrets only to verified enclaves
- Example response: `{"ANTHROPIC_API_KEY": "sk-..."}`

### Strategy 2: TEE Platform Secrets (Phala)

**Use when**: Deploying to Phala Cloud or similar TEE platforms

```bash
PROFILE=prod
NODE_ENV=production
ANTHROPIC_API_KEY=sk-...     # Encrypted and injected by Phala
```

The platform encrypts secrets and injects them as environment variables. `SecretsService` automatically loads them.

### Strategy 3: Environment Variables (Basic VPS)

**Use when**: Deploying to basic Ubuntu VPS without TEE. Not in production mode: production attests only through dstack and refuses to start without it.

```bash
PROFILE=prod
NODE_ENV=production
ALLOW_KEYS_OUTSIDE_ENCLAVE=true
OPERATOR_PRIVATE_KEY=0x...  # From .env or systemd service
```

⚠️ **Warning**: Without TEE, the host can access memory and secrets. Use only for testing or low-stakes deployments.

### Strategy 4: Development Mode (Local)

**Use when**: Local development and testing

```bash
PROFILE=local
OPERATOR_PRIVATE_KEY=0x...  # Optional, auto-generates if not set
```

If not provided, a deterministic dev key is generated automatically.

## Platform-Specific Setup

The AMD SEV-SNP, Intel TDX and AWS Nitro adapters below are not production-ready. In production, Longjing attests only through dstack ([Phala Network](#phala-network-intel-tdxsgx)) and refuses to start on any other platform.

### AMD SEV-SNP

AMD Secure Encrypted Virtualization - Secure Nested Paging provides VM-level isolation with encrypted memory and attestation.

#### Hardware Requirements
- AMD EPYC 3rd Gen (Milan) or newer processor
- SEV-SNP enabled in BIOS
- Host OS with SEV-SNP support (Linux kernel 5.19+)

#### Installation Steps

1. **Enable SEV-SNP on the host**:
   ```bash
   # Check if SEV-SNP is available
   dmesg | grep -i sev

   # Should show: AMD Memory Encryption Features active: SEV SEV-ES SEV-SNP
   ```

2. **Install SEV-SNP guest tools**:
   ```bash
   # Ubuntu/Debian
   apt-get update
   apt-get install -y snpguest

   # Or build from source
   git clone https://github.com/virtee/snpguest
   cd snpguest
   cargo build --release
   cp target/release/snpguest /usr/local/bin/
   ```

3. **Verify device access**:
   ```bash
   ls -l /dev/sev-guest
   # Should show: crw------- 1 root root

   # Grant access to the application user if needed
   usermod -a -G sev <app-user>
   ```

4. **Launch the VM with SEV-SNP**:
   ```bash
   qemu-system-x86_64 \
     -enable-kvm \
     -cpu EPYC-v4 \
     -machine q35,confidential-guest-support=sev0,memory-backend=ram1 \
     -object memory-backend-memfd,id=ram1,size=4G,share=true,prealloc=false \
     -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1 \
     -m 4G \
     -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE.fd \
     -drive if=pflash,format=raw,file=/path/to/OVMF_VARS.fd \
     -drive file=disk.qcow2,if=none,id=disk0,format=qcow2 \
     -device virtio-scsi-pci,id=scsi0,disable-legacy=on,iommu_platform=true \
     -device scsi-hd,drive=disk0 \
     -netdev user,id=vmnic,hostfwd=tcp::3443-:443 \
     -device virtio-net-pci,disable-legacy=on,iommu_platform=true,netdev=vmnic \
     -nographic
   ```

5. **Inside the VM, verify SEV-SNP is active**:
   ```bash
   snpguest report /tmp/test.bin
   # Should succeed without errors
   ```

6. **Deploy the application**:
   ```bash
   # Copy application files to the VM
   cd /app/longjing

   # Generate TLS certificates inside the enclave
   mkdir -p /run/secrets
   openssl req -x509 -newkey rsa:4096 \
     -keyout /run/secrets/tls.key \
     -out /run/secrets/tls.cert \
     -days 365 -nodes \
     -subj "/CN=your-domain.com"

   # Start the application
   PROFILE=prod NODE_ENV=production node dist/main.js
   ```

#### Attestation Verification

```bash
# Get attestation report
curl -k https://your-server:443/secret/attestation > attestation.json

# Extract and verify the report
cat attestation.json | jq -r '.report' | base64 -d > report.bin

# Verify with AMD KDS (Key Distribution Server)
snpguest verify report.bin --platform amd-sev-snp
```

### Intel TDX

Intel Trust Domain Extensions provides VM-level isolation with hardware-enforced confidentiality.

#### Deployment Readiness

✅ **Production Ready** - Longjing has full Intel TDX support with:
- Automatic TDX platform detection
- Attestation report generation using `tdx-attest` tool
- Fallback to direct `/dev/tdx-guest` device access
- User data binding for nonce commitments
- Comprehensive test coverage

#### Hardware Requirements
- Intel Xeon Scalable 4th Gen (Sapphire Rapids) or newer
- TDX enabled in BIOS
- Host OS with TDX support (Linux kernel 5.19+)

#### Installation Steps

1. **Verify TDX support**:
   ```bash
   # Check CPU capabilities
   grep -o 'tdx_guest' /proc/cpuinfo

   # Check kernel module
   lsmod | grep tdx
   ```

2. **Install TDX attestation tools** (Required for production):
   ```bash
   # Ubuntu/Debian
   wget https://download.01.org/intel-sgx/latest/linux-latest/distro/ubuntu22.04-server/tdx-attest.deb
   dpkg -i tdx-attest.deb

   # Or build from source
   git clone https://github.com/intel/SGXDataCenterAttestationPrimitives
   cd QuoteGeneration/linux
   make
   make install
   ```

   **Important**: The `tdx-attest` tool is the recommended method for generating TDX quotes. While Longjing has a fallback that reads directly from `/dev/tdx-guest`, the fallback is simplified and may not work correctly in all TDX environments.

3. **Verify TDX device access**:
   ```bash
   ls -l /dev/tdx-guest
   # or
   ls -l /dev/tdx_guest

   # Check TDX module info
   cat /sys/firmware/tdx_seam/version

   # Verify tdx-attest tool works
   tdx-attest --version
   ```

4. **Launch TD (Trust Domain)**:
   ```bash
   # Using QEMU with TDX support
   qemu-system-x86_64 \
     -accel kvm \
     -m 4G \
     -smp 4 \
     -object tdx-guest,id=tdx0 \
     -machine q35,kernel_irqchip=split,confidential-guest-support=tdx0,memory-backend=ram1 \
     -object memory-backend-memfd,id=ram1,size=4G,prealloc=true \
     -cpu host,-kvm-steal-time \
     -bios /usr/share/qemu/OVMF.fd \
     -drive file=disk.qcow2,if=virtio \
     -netdev user,id=vmnic,hostfwd=tcp::3443-:443 \
     -device virtio-net-pci,netdev=vmnic \
     -nographic
   ```

5. **Inside the TD, verify TDX is active**:
   ```bash
   # Generate test quote
   tdx-attest quote /tmp/test-quote.dat

   # Check MRTD (Measurement Register for TD)
   tdx-attest info

   # Verify device permissions
   ls -l /dev/tdx-guest
   # Should be readable by the application user
   ```

6. **Deploy the application**:
   ```bash
   cd /app/longjing

   # Generate TLS certificates inside the TD
   mkdir -p /run/secrets
   openssl req -x509 -newkey rsa:4096 \
     -keyout /run/secrets/tls.key \
     -out /run/secrets/tls.cert \
     -days 365 -nodes \
     -subj "/CN=your-domain.com"

   # Start the application
   PROFILE=prod NODE_ENV=production node dist/main.js
   ```

#### Attestation Verification

```bash
# Get attestation report
curl -k https://your-server:443/secret/attestation > attestation.json

# Verify the platform is TDX
cat attestation.json | jq -r '.platform'
# Expected output: "intel-tdx"

# Extract quote
cat attestation.json | jq -r '.report' | base64 -d > quote.dat

# Extract measurement (MRTD)
cat attestation.json | jq -r '.measurement'
# This is the hex-encoded measurement of your TD

# Verify with Intel Attestation Service
# Use Intel's DCAP (Data Center Attestation Primitives) verification library
# For example, using Intel's quote verification library:
# https://github.com/intel/SGXDataCenterAttestationPrimitives
```

#### Implementation Details

**How Longjing generates TDX attestation:**

1. **Primary method**: Executes `tdx-attest quote /tmp/tdx-quote.dat` command
   - This is the recommended approach for production
   - Requires `tdx-attest` tool to be installed in the TD
   - Generates a properly formatted TDX quote structure

2. **Fallback method**: Reads directly from `/dev/tdx-guest` device
   - Used only if `tdx-attest` command fails
   - Simplified implementation using direct device read
   - May not work correctly in all TDX environments

**Attestation report structure:**
```json
{
  "platform": "intel-tdx",
  "report": "base64-encoded-tdx-quote",
  "measurement": "hex-encoded-mrtd-hash",
  "timestamp": "2026-03-18T..."
}
```

**Detection logic** (src/attestation/platforms/tdx.platform.ts), outside production only.

#### Production Recommendations

1. **Always install `tdx-attest` tool**: Don't rely on the fallback device read method
2. **Verify quote structure**: Ensure the generated quotes are valid TDX quote format
3. **Test attestation before production**: Use Intel's verification service to validate quotes
4. **Monitor attestation failures**: Log and alert on attestation generation errors
5. **Keep TDX firmware updated**: Intel regularly releases TDX security patches

### AWS Nitro Enclaves

AWS Nitro Enclaves provide isolated compute environments on EC2 instances.

#### Prerequisites
- EC2 instance with Nitro Enclaves support (M5, M5d, M6i, C5, C5d, C6i, R5, R5d, R6i, etc.)
- Amazon Linux 2 or Ubuntu 20.04+
- At least 4 vCPUs (2 for enclave, 2 for parent)

#### Installation Steps

1. **Install Nitro CLI**:
   ```bash
   # Amazon Linux 2
   sudo amazon-linux-extras install aws-nitro-enclaves-cli -y
   sudo yum install aws-nitro-enclaves-cli-devel -y

   # Ubuntu
   wget https://github.com/aws/aws-nitro-enclaves-cli/releases/latest/download/nitro-cli_$(uname -m).deb
   sudo dpkg -i nitro-cli_$(uname -m).deb
   ```

2. **Configure the instance**:
   ```bash
   # Allocate resources for enclaves (2 vCPUs, 2048 MB memory)
   sudo sed -i 's/^cpu_count:.*/cpu_count: 2/' /etc/nitro_enclaves/allocator.yaml
   sudo sed -i 's/^memory_mib:.*/memory_mib: 2048/' /etc/nitro_enclaves/allocator.yaml

   # Enable and start the allocator service
   sudo systemctl enable --now nitro-enclaves-allocator.service
   sudo systemctl enable --now docker

   # Add user to docker and ne groups
   sudo usermod -aG docker $USER
   sudo usermod -aG ne $USER

   # Re-login for group changes to take effect
   ```

3. **Build enclave image**:
   ```bash
   # Create Dockerfile for enclave
   cat > Dockerfile.enclave <<EOF
   FROM node:24-slim

   WORKDIR /app

   # Copy application files
   COPY package*.json pnpm-lock.yaml ./
   COPY dist ./dist

   # Install dependencies
   RUN npm install -g pnpm && pnpm install --prod

   # Generate TLS certificates
   RUN mkdir -p /run/secrets && \
       openssl req -x509 -newkey rsa:4096 \
       -keyout /run/secrets/tls.key \
       -out /run/secrets/tls.cert \
       -days 365 -nodes \
       -subj "/CN=enclave.local"

   # Set environment
   ENV PROFILE=prod
   ENV NODE_ENV=production

   EXPOSE 443

   CMD ["node", "dist/main.js"]
   EOF

   # Build Docker image
   docker build -f Dockerfile.enclave -t longjing-enclave:latest .

   # Build Nitro Enclave Image File (EIF)
   nitro-cli build-enclave \
     --docker-uri longjing-enclave:latest \
     --output-file longjing.eif

   # Save PCR values for attestation verification
   nitro-cli describe-eif --eif-path longjing.eif > pcr-values.json
   ```

4. **Run the enclave**:
   ```bash
   # Start the enclave
   nitro-cli run-enclave \
     --eif-path longjing.eif \
     --cpu-count 2 \
     --memory 2048 \
     --enclave-cid 16 \
     --debug-mode

   # Check enclave status
   nitro-cli describe-enclaves

   # View enclave console (debug mode only)
   nitro-cli console --enclave-id $(nitro-cli describe-enclaves | jq -r '.[0].EnclaveID')
   ```

5. **Set up parent instance proxy** (to forward traffic to enclave):
   ```bash
   # Install vsock-proxy
   sudo yum install socat -y

   # Forward port 443 to enclave
   socat TCP-LISTEN:443,fork VSOCK-CONNECT:16:443 &
   ```

#### Attestation Verification

```bash
# Get attestation report
curl https://your-server:443/secret/attestation > attestation.json

# Extract and parse attestation document (CBOR format)
cat attestation.json | jq -r '.report' | base64 -d > attestation.cbor

# Verify using aws-nitro-enclaves-cose
# Install verification tools
pip install cbor2 cryptography

# Python script to verify attestation
python3 <<EOF
import cbor2
import base64
from cryptography import x509
from cryptography.hazmat.backends import default_backend

# Load attestation document
with open('attestation.cbor', 'rb') as f:
    attestation = cbor2.load(f)

# Verify signature and certificate chain
# Extract PCRs and compare with expected values
print(f"PCR0: {attestation['pcrs'][0].hex()}")
print(f"PCR1: {attestation['pcrs'][1].hex()}")
print(f"PCR2: {attestation['pcrs'][2].hex()}")

# Compare with values from pcr-values.json
EOF
```

### Phala Network (Intel TDX/SGX)

[Phala Network](https://phala.network/) provides TEE-as-a-Service infrastructure through [Phala Cloud](https://cloud.phala.network/) and [Dstack](https://docs.phala.com/dstack/overview), supporting Intel TDX, Intel SGX, AMD SEV, and GPU TEE.

**Why Phala + Longjing?** Phala simplifies TEE deployment (containerized apps, one-click deployment), while Longjing is designed to add cryptographic unlinkability that even Phala's infrastructure cannot violate. Together they provide:
- **Phala**: Hardware isolation, remote attestation, decentralized infrastructure
- **Longjing**: Payment unlinkability that survives regulatory demands, as a design goal: at v0.4.0, requests can still be linked to deposits ([#134](https://github.com/w3hc/longjing/issues/134))

#### Overview

Phala Network is a trustless cloud infrastructure platform that enables deployment of Docker-based applications into TEE environments in minutes. Phala uses [Dstack](https://github.com/Dstack-TEE/dstack), an open-source TEE SDK and guest OS (Confidential Computing Consortium project under Linux Foundation), to simplify deployment of arbitrary Docker containers into TEE.

**Compatibility Status:**
- ✅ **Intel TDX** - Compatible (Phala supports via Dstack, Longjing supports)
- ❌ **Intel SGX** - Not supported by Longjing (SGX uses different APIs than TDX)
- ⚠️ **AMD SEV** - Phala's AMD support may differ from Longjing's SEV-SNP implementation
- ❌ **GPU TEE (NVIDIA H100/H200)** - Not supported by Longjing

**Key Resources:**
- [Phala Cloud Platform](https://cloud.phala.network/)
- [Dstack Documentation](https://docs.phala.com/dstack/getting-started)
- [Dstack GitHub Repository](https://github.com/Dstack-TEE/dstack)
- [Hardware Requirements](https://docs.phala.com/dstack/hardware-requirements)
- [Attestation Overview](https://docs.phala.com/phala-cloud/attestation/overview)
- [AMD SEV vs Intel TDX vs NVIDIA GPU TEE Comparison](https://phala.com/learn/AMD-SEV-vs-Intel-TDX-vs-NVIDIA-GPU-TEE)

#### Deployment on Phala (Intel TDX)

If you want to deploy Longjing on Phala's Intel TDX infrastructure using Dstack:

**Prerequisites:**

1. **Hardware Requirements:**
   - Bare metal Intel TDX server following [canonical/tdx specifications](https://github.com/canonical/tdx)
   - Intel Xeon 5th/6th Generation CPU (TDX support required)
   - Minimum 16GB RAM, 100GB free disk space
   - BIOS configuration: Enable Intel TDX, VT-x/VT-d, SR-IOV
   - See [Phala's Hardware Requirements](https://docs.phala.com/dstack/hardware-requirements)

2. **Software Setup:**
   - Ubuntu 24.04 (recommended)
   - Dstack SDK installed
   - Docker support for containerization

3. **Account Setup:**
   - Phala Cloud account (if using managed service)
   - Access to TDX-enabled nodes

**Installation Steps:**

1. **Set up Dstack environment** following [Phala's Getting Started Guide](https://docs.phala.com/dstack/getting-started):
   ```bash
   # Install build tools (Ubuntu 24.04)
   sudo apt-get update
   sudo apt-get install build-essential git

   # Clone meta-dstack repository
   git clone https://github.com/Phala-Network/meta-dstack
   cd meta-dstack

   # Follow Intel's TDX enabling guide if needed
   # https://cc-enabling.trustedservices.intel.com/intel-tdx-enabling-guide/
   ```

2. **Configure BIOS** (before OS installation):
   - Enable Intel TDX
   - Enable Intel VT-x / VT-d
   - Enable SR-IOV (if available)
   - Refer to [Intel TDX Enabling Guide](https://cc-enabling.trustedservices.intel.com/intel-tdx-enabling-guide/04/hardware_setup/)

3. **Verify TDX device access** in Dstack environment:
   ```bash
   ls -l /dev/tdx-guest
   # or
   ls -l /dev/tdx_guest

   # Verify TDX is active
   cat /sys/firmware/tdx_seam/version
   ```

4. **Containerize Longjing** for Dstack deployment:
   ```dockerfile
   # Dockerfile
   FROM node:24-slim

   WORKDIR /app

   # Copy application
   COPY package*.json pnpm-lock.yaml ./
   COPY dist ./dist

   # Install dependencies
   RUN npm install -g pnpm && pnpm install --prod

   # Install tdx-attest tools inside container
   RUN apt-get update && \
       apt-get install -y wget && \
       wget https://download.01.org/intel-sgx/latest/linux-latest/distro/ubuntu22.04-server/tdx-attest.deb && \
       dpkg -i tdx-attest.deb || apt-get install -f -y

   # Generate TLS certificates inside TEE
   RUN mkdir -p /run/secrets && \
       openssl req -x509 -newkey rsa:4096 \
       -keyout /run/secrets/tls.key \
       -out /run/secrets/tls.cert \
       -days 365 -nodes \
       -subj "/CN=longjing.phala.network"

   ENV PROFILE=prod
   ENV NODE_ENV=production

   EXPOSE 443

   CMD ["node", "dist/main.js"]
   ```

5. **Deploy to Phala Cloud** using [Phala Cloud CLI](https://docs.phala.com/phala-cloud/phala-cloud-cli/start-from-cloud-cli):
   ```bash
   # Build and push Docker image
   docker build -t longjing:latest .
   docker push your-registry/longjing:latest

   # Deploy using Phala Cloud CLI (if using managed service)
   # or follow Dstack deployment instructions for self-hosted
   ```

6. **Verify deployment** following the standard [Intel TDX](#intel-tdx) verification steps

**Attestation Integration:**

Phala provides comprehensive attestation capabilities. When running Longjing on Phala:

1. **Longjing's Native Attestation:**
   - Longjing's `/attestation` endpoint generates standard Intel TDX quotes
   - Uses `tdx-attest` tool or `/dev/tdx-guest` device access
   - Returns platform-specific attestation reports

2. **Phala's Attestation Services:**
   - [Get Attestation](https://docs.phala.com/phala-cloud/attestation/get-attestation) - Dashboard and CLI access to attestation reports
   - [Verify Your Application](https://docs.phala.com/phala-cloud/attestation/verify-your-application) - Verification methods
   - [Onchain Verification](https://docs.phala.com/phala-cloud/attestation/overview) - Smart contract verification using Automata's DCAP verifier
   - CLI command: `phala cvms attestation` to view TEE attestation reports

3. **Verification Options:**
   - **Smart Contract:** Use Automata's onchain DCAP verifier (Solidity)
   - **Intel DCAP:** Standard Intel verification service
   - **Phala Trust Center:** Automated verification platform
   - **Custom Integration:** Longjing can integrate with Phala's verification APIs

**Architecture Considerations:**

When deploying on Phala/Dstack:

1. **CVM (Confidential Virtual Machine):**
   - Dstack creates a TDX-based VM for your application
   - Hypervisor (QEMU) launches the VM with TDX enabled
   - Each application gets one CVM with hardware-level isolation

2. **Networking:**
   - Verify network isolation meets Longjing's security requirements
   - Configure domains and ports in Dstack build configuration
   - Consider [TEE-Controlled Domain Certificates](https://docs.phala.com/dstack/design-documents/tee-controlled-domain-certificates)

3. **Trust Model:**
   - [Decentralized Root-of-Trust](https://docs.phala.com/dstack/design-documents/decentralized-root-of-trust) - Phala's trust architecture
   - [Dstack Whitepaper](https://docs.phala.com/dstack/design-documents/whitepaper) - Technical design details
   - Compatible with Longjing's trust assumptions for TDX

**Limitations:**

1. **Intel SGX not supported**: If you need SGX specifically, Longjing would require additional development to support SGX's different attestation APIs (`/dev/sgx_enclave`, `/dev/sgx_provision`)

2. **Platform-specific features**: Phala provides additional services (key management, decentralized verification, onchain attestation) that may require custom integration beyond Longjing's default KMS integration

3. **GPU TEE**: Longjing does not support [Phala's GPU TEE infrastructure](https://docs.phala.com/phala-cloud/confidential-ai/confidential-gpu/deploy-and-verify) (NVIDIA H100/H200)

4. **Docker requirement**: Longjing must be containerized for Dstack deployment

**Comparison with Other Platforms:**

For platform comparisons, see:
- [Phala Cloud vs Azure Confidential Computing](https://phala.network/posts/Phala-Cloud-vs-Azure)
- [Phala's Defense in Depth Solution with TEE](https://phala.com/posts/phalas-defense-in-depth-solution-with-tee)

**Future Support:**

To add Intel SGX support for broader Phala compatibility, Longjing would need:
- SGX attestation service implementation using Intel SGX SDK
- Support for EPID or DCAP attestation modes
- Device access to `/dev/sgx_enclave` and `/dev/sgx_provision`
- Reference: [How Phala adapted after Intel SGX breach](https://the-scarlet-thread.medium.com/intel-sgx-breach-what-it-means-for-tees-and-how-phala-network-is-adapting-ce918af75319)

**Additional Resources:**

- [Phala Network Overview](https://docs.phala.com/network/overview/phala-network)
- [Dstack Examples Repository](https://github.com/dstack-tee/dstack-examples)
- [Phala Cloud FAQ](https://docs.phala.com/phala-cloud/faqs)
- [Deploy a dApp on Phala Cloud - Step-by-Step Guide](https://phala.com/posts/how-to-deploy-a-dapp-on-phala-cloud-a-stepbystep-guide)
- [Phala-Intel Partnership](https://phala.com/posts/phala-intel)

For questions about Phala-specific deployment, consult:
- Phala Network documentation: https://docs.phala.com/
- Phala GitHub: https://github.com/Phala-Network
- Dstack GitHub: https://github.com/Dstack-TEE/dstack

## General TEE Configuration

### Environment Variables

Create a production `.env` file inside the TEE:

```bash
PROFILE=prod
NODE_ENV=production
PORT=443
KMS_URL=https://kms.your-domain.com/release  # example.com URLs are refused
TLS_KEY_PATH=/run/secrets/tls.key
TLS_CERT_PATH=/run/secrets/tls.cert
```

### KMS Integration

Configure your Key Management Service to release secrets only after attestation verification:

1. **KMS should verify**:
   - Platform-specific attestation report signature
   - Measurement hash matches expected value
   - Timestamp is recent (within acceptable time window)
   - Platform is a legitimate TEE (AMD SEV-SNP, Intel TDX, or AWS Nitro)

2. **Expected measurement calculation**:
   ```bash
   # For Docker images
   docker inspect longjing:latest | jq -r '.[0].RootFS.Layers[]' | sha256sum

   # For AWS Nitro
   cat pcr-values.json | jq -r '.Measurements.PCR0'
   ```

3. **KMS endpoint example**:
   ```bash
   curl -X POST https://your-kms.example.com/release \
     -H "Content-Type: application/json" \
     -d '{
       "attestation_report": "base64-encoded-report",
       "platform": "amd-sev-snp",
       "measurement": "hex-measurement"
     }'
   ```

## Verification and Testing

### 1. Test Attestation Endpoint

```bash
# Check if attestation is working
curl -k https://your-server:443/attestation | jq .

# Expected response:
# {
#   "platform": "phala" | "intel-tdx" | "amd-sev-snp" | "aws-nitro",
#   "quote": "base64-encoded-attestation-quote",
#   "reportData": "hex: key commitment || nonce, 128 chars",
#   "nonce": null,
#   "keys": { "mlkemPublicKey": "...", "identityPublicKey": "0x04...", ... },
#   "eventLog": "[...]",
#   "measurement": "hex-measurement-hash",
#   "timestamp": "2026-03-17T...",
#   "instructions": "Platform-specific verification instructions..."
# }

# If platform is "mock", you're NOT in a TEE
```

### 2. Verify the Key Binding (Critical Security Check)

The attestation quote's `report_data` commits to every public key Longjing uses, the **ML-KEM key**, the **identity key** and the **refund signer key**, and to the **in-enclave TLS certificate**, followed by a **nonce** the client chooses. This provides four guarantees:

1. **Key Origin**: The keys were derived **inside the TEE**, not loaded from environment variables
2. **MITM Prevention**: An attacker cannot serve their own encryption key, or sign refund tickets outside the enclave, while replaying a valid TEE attestation
3. **TLS Endpoint Binding**: The TLS certificate the server presents is bound to the quote, proving the TLS session terminates **inside the attested enclave** (not at an external proxy)
4. **Freshness**: The quote carries the client's nonce, so it was generated for this request

**How it works:**
- At startup, Longjing derives its ML-KEM-1024, identity and refund signer keys inside the enclave from the dstack KMS (`GetKey`, see [KEY_DERIVATION.md](KEY_DERIVATION.md))
- The private keys are never stored and never leave the TEE, and every instance of the app derives the same keys
- The TLS private key is derived in-enclave via the dstack KMS (or loaded from enclave-only storage)
- `GET /attestation?nonce=<hex>` returns the quote, the keys `report_data` commits to and the event log; the layout is in [ATTESTATION.md](ATTESTATION.md#report_data)
- A null `keys.tlsCertificate` means the server is **not** terminating TLS itself — treat that as a weaker deployment

**Security comparison:**
- ❌ **Old approach**: Keys in `ADMIN_MLKEM_PRIVATE_KEY` environment variable → Operator can access private key
- ✅ **New approach**: Keys derived in TEE → Private key never known to anyone, cryptographically proven via attestation and the signed key manifest (`GET /attestation/manifest`)

**Automated Verification:**

```bash
# Sends a fresh nonce, rebuilds report_data from the returned keys, checks the
# served TLS certificate and replays RTMR0–3 from the event log
pnpm verify:attestation https://your-server:443/attestation
```

**Manual Verification:** follow [ATTESTATION.md](ATTESTATION.md#verification), which has a Python version of the `report_data` rebuild.

**What This Proves:**
- The attestation quote was generated for your nonce, with knowledge of the returned keys
- An attacker cannot substitute their own key or replay an old quote (the commitment or the nonce won't match)
- The encryption and refund signing keys are cryptographically bound to the TEE measurement

**Security Impact:**
Without the key binding, an attacker could:
1. Serve their own ML-KEM public key (to decrypt your secrets)
2. Replay a valid TEE attestation from the real server
3. Client thinks it's secure, but secrets are encrypted to attacker's key

With the key binding and a fresh nonce, this attack is cryptographically impossible.

### 3. Verify TLS Termination Inside TEE

In production, Longjing terminates TLS **inside the enclave**. The TLS private key is obtained in one of two ways, and the server **fails closed** if neither is available:

1. **dstack KMS (Phala/Dstack — default)**: the key is derived inside the CVM via `getTlsKey()` on `/var/run/dstack.sock`. It exists only in enclave memory and never touches the host.
2. **Operator-provisioned** (`TLS_KEY_PATH` / `TLS_CERT_PATH`): under the `ALLOW_KEYS_OUTSIDE_ENCLAVE` opt-out; the files must live in enclave-only storage. Production still requires dstack for attestation.

Setting `ALLOW_EXTERNAL_TLS_TERMINATION=true` restores plain HTTP behind an external TLS proxy. **Do not use this with real user data** — request bodies, including the prompts sent to `/longjing/request`, become visible in plaintext at the termination proxy, outside the TEE trust boundary.

**Phala/dstack gateway configuration:** the gateway must run in **TLS-passthrough mode** so it forwards raw TLS to the enclave instead of terminating it. Use the `s`-suffixed port in the gateway domain:

```
https://<app-id>-3000s.<gateway-base-domain>     ← TLS passthrough (correct)
https://<app-id>-3000.<gateway-base-domain>      ← gateway terminates TLS (do NOT use)
```

**Verification:**

```bash
# 1. The served certificate must be the keys.tlsCertificate that report_data
#    commits to (see section 2 above) — this is the cryptographic proof
#    that your TLS session ends inside the attested enclave. Automated:
pnpm verify:attestation https://your-server:443/attestation

# 2. Confirm the TLS private key never touched the host filesystem
sudo find /var /tmp /root -name "tls.key" 2>/dev/null
# Should return no results (dstack-derived keys exist only in enclave memory)
```

### 4. Test Health Endpoints

```bash
# Health check
curl -k https://your-server:443/health

# Readiness probe
curl -k https://your-server:443/health/ready

# Liveness probe
curl -k https://your-server:443/health/live
```

### 5. Verify Logging is Sanitized

```bash
# Check application logs - should NOT contain sensitive data
# Test by sending a request with sensitive data
curl -k -X POST https://your-server:443/longjing/estimate-cost \
  -H "Content-Type: application/json" \
  -d '{"provider": "claude", "estimatedUnits": 1000, "metadata": {"note": "my-password-123 sensitive info"}}'

# Check logs - should NOT show "my-password-123" or "sensitive info"
# Only sanitized entries like: "Request received" without actual data
```

## Security Considerations

### Best Practices

1. **Never share TLS private keys**: Generate certificates inside the TEE, never import from outside
2. **Verify attestation before sending data**: Clients must verify attestation reports before transmitting sensitive information
3. **Use secure KMS**: Implement attestation-based key release in your KMS
4. **Monitor for side-channel attacks**: Keep TCB-level advisories for your platform in view
5. **Regular security updates**: Keep TEE firmware and guest OS patched
6. **Implement rate limiting**: Protect against DoS attacks (already configured in the app)
7. **Log monitoring**: Review logs for unusual patterns while ensuring no sensitive data is logged

### Threat Model Reminder

**Protected against**:
- Malicious host operator reading memory
- Network eavesdropping (TLS terminates in enclave)
- Log-based data exfiltration
- Stack trace information leakage

**NOT protected against**:
- Side-channel attacks (timing, cache, power analysis)
- Physical access to hardware
- Compromised TEE firmware/hardware
- Application logic vulnerabilities
- Social engineering

### Trust Assumptions

You MUST trust:
1. TEE hardware vendor (AMD/Intel/AWS/Phala infrastructure provider)
2. This application code (verify source and attestation)
3. KMS that releases secrets
4. Build process integrity
5. For Phala/Dstack: The Dstack SDK and hypervisor (QEMU) stack

You do NOT need to trust:
1. Host OS or cloud provider operator
2. Network infrastructure
3. Storage backend (if properly encrypted)

## Troubleshooting

### Common Issues

#### "No TEE detected" in production

**Problem**: Application shows `platform: "none"` in attestation endpoint.

**Solution**:
```bash
# Check device files exist
ls -l /dev/sev-guest /dev/tdx-guest /dev/nsm

# Check kernel modules loaded
lsmod | grep -E 'sev|tdx|nsm'

# Check BIOS settings - ensure TEE is enabled

# For VMs, ensure launched with proper parameters
```

#### Attestation generation fails

**Problem**: Error logs show "Failed to generate X attestation".

**Solution**:
```bash
# Verify platform tools are installed
which snpguest  # For AMD SEV-SNP
which tdx-attest  # For Intel TDX (REQUIRED for production)
which nitro-cli  # For AWS Nitro

# Check permissions
ls -l /dev/sev-guest  # Should be readable by app user
ls -l /dev/tdx-guest  # Should be readable by app user

# Test tool directly
snpguest report /tmp/test.bin  # AMD
tdx-attest quote /tmp/test.dat  # Intel TDX
nitro-cli describe-enclaves  # AWS
```

**Intel TDX Specific Issues**:

**Problem**: "TDX attestation generation failed" errors

**Diagnosis**:
```bash
# Check if tdx-attest is installed
which tdx-attest
# If not found, install it (see Installation Steps above)

# Check device access
ls -l /dev/tdx-guest
# Should show: crw------- or similar

# Test tdx-attest directly
tdx-attest quote /tmp/test-quote.dat
# Should succeed without errors

# Check system logs for TDX errors
dmesg | grep -i tdx
journalctl -xe | grep -i tdx
```

**Common TDX issues**:
1. **`tdx-attest` not installed**: Install the tool (required for production)
2. **Device permission denied**: Add app user to appropriate group or adjust device permissions
3. **TDX module not loaded**: Check `lsmod | grep tdx` and ensure kernel supports TDX
4. **Invalid TDX configuration**: Verify BIOS settings and VM launch parameters

#### TLS certificate errors

**Problem**: "ENOENT: no such file or directory, open '/run/secrets/tls.key'"

**Solution**:
```bash
# Ensure secrets directory exists
mkdir -p /run/secrets

# Generate certificates inside TEE
openssl req -x509 -newkey rsa:4096 \
  -keyout /run/secrets/tls.key \
  -out /run/secrets/tls.cert \
  -days 365 -nodes \
  -subj "/CN=your-domain.com"

# Check permissions
chmod 600 /run/secrets/tls.key
chmod 644 /run/secrets/tls.cert
```

#### Performance issues

**Problem**: Application runs slowly inside TEE.

**Solution**:
```bash
# Allocate more resources
# For AMD/Intel VMs: increase vCPUs and memory
# For AWS Nitro: adjust enclave configuration
# For Phala/Dstack: adjust CVM resource allocation in deployment config

# Check for side-channel mitigations overhead
# Some mitigations can impact performance

# Monitor resource usage
top
free -h
```

**Phala/Dstack Specific**:
- Review [Phala Cloud pricing](https://phala.network/posts/introducing-phala-cloud-pricing-affordable-secure-scalable) for resource tiers
- Adjust CVM configuration in your deployment
- Check Dstack build configuration for resource limits

### Getting Help

- Check application logs (sanitized, safe to share)
- Review platform-specific documentation
- File issues at the Longjing repository
- Consult TEE platform vendor support

### Useful Commands Reference

```bash
# AMD SEV-SNP
snpguest report /tmp/report.bin
snpguest verify /tmp/report.bin

# Intel TDX
tdx-attest quote /tmp/quote.dat
tdx-attest info
tdx-attest --version

# AWS Nitro
nitro-cli describe-enclaves
nitro-cli console --enclave-id <ID>
nitro-cli describe-eif --eif-path <path>

# Phala Cloud / Dstack
phala cvms attestation          # View TEE attestation reports
phala cvms list                 # List your CVMs
# See: https://docs.phala.com/phala-cloud/phala-cloud-cli/start-from-cloud-cli

# Longjing Application
curl -k https://localhost:443/secret/attestation
curl -k https://localhost:443/health
PROFILE=prod NODE_ENV=production node dist/main.js

# Docker (for Phala deployment)
docker build -t longjing:latest .
docker push your-registry/longjing:latest
```

## Next Steps

After successful deployment:

1. **Integrate with your KMS**: Configure attestation-based secret release
2. **Set up monitoring**: Track attestation verification attempts, error rates
3. **Implement client verification**: Ensure clients verify attestation before sending data
4. **Document your deployment**: Record measurement hashes, PCR values for verification
5. **Plan for updates**: Develop a strategy for updating code while maintaining attestation

For more information:
- [README.md](../README.md) - General project information
- Platform documentation:
  - [AMD SEV-SNP Documentation](https://www.amd.com/en/developer/sev.html)
  - [Intel TDX Documentation](https://www.intel.com/content/www/us/en/developer/tools/trust-domain-extensions/overview.html)
  - [AWS Nitro Enclaves Documentation](https://docs.aws.amazon.com/enclaves/)
  - [Phala Network Documentation](https://docs.phala.com/)
  - [Dstack Documentation](https://docs.phala.com/dstack/getting-started)
