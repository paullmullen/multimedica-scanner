# Multimedica Scanner Appliance Installation Guide

## Purpose

This guide describes how to install, provision, and validate a Multimedica Scanner Appliance.

The intended audience is a technically capable installer who is comfortable with:

- Windows
- Raspberry Pi
- SSH
- GitHub
- Basic networking

No prior knowledge of the Multimedica project is assumed.

---

# Overview

A Multimedica Scanner Appliance consists of:

- Raspberry Pi 4B
- USB barcode scanner
- HDMI kiosk display
- Multimedica Scanner software
- Multimedica Kiosk Display software

The appliance:

1. Reads patient barcode scans
2. Communicates with the Multimedica cloud platform
3. Displays room status to patients and staff
4. Supports QR-code based field configuration
5. Can be reprovisioned without editing configuration files

---

# Pre-Install Checklist

## Hardware

- [ ] Raspberry Pi 4B
- [ ] 32GB+ SD Card
- [ ] Power Supply
- [ ] HDMI Display
- [ ] USB Barcode Scanner
- [ ] Network Access

## QR Codes

- [ ] WiFi Configuration QR
- [ ] Cloud Configuration QR
- [ ] Station Configuration QR
- [ ] Identity QR

## Software / Access

- [ ] GitHub Access
- [ ] Windows Workstation
- [ ] Raspberry Pi Imager Installed
- [ ] Multimedica Admin Access

## Expected Time

- New Scanner Build: 30–45 minutes
- Replacement Scanner: 10–15 minutes

---

# Command Conventions

## [WINDOWS]

Commands run from a Windows workstation.

## [PI]

Commands run on the Raspberry Pi, usually through an SSH session.

## [SCANNER]

Actions performed by scanning QR codes with the scanner appliance.

---

# Installation Process

## Build the Appliance

- Generate QR codes
- Assemble hardware
- Flash Raspberry Pi OS
- Install scanner software
- Verify operation

## Provision (setup/configure) the Appliance

- Configure WiFi
- Configure cloud connectivity
- Assign station and room
- Verify identity
- Validate operation

---

# Hardware Requirements

## Known Working Hardware

| Component    | Model                       |
| ------------ | --------------------------- |
| Raspberry Pi | Raspberry Pi 4B             |
| Scanner      | BF SCAN USB Barcode Scanner |
| Display      | Waveshare 4.3" HDMI LCD     |
| Printer      | Epson TM-m30III             |

---

# Hardware Assembly

## Components

- Raspberry Pi 4B
- Waveshare 4.3" HDMI LCD
- HDMI jumper board (included with display)
- Display standoffs and screws
- USB barcode scanner
- Right-angle USB-C power cable
- Raspberry Pi power supply

## Attach the Display

### Step 1 – Connect the GPIO Header

Align the display board with the Raspberry Pi GPIO header.

Verify:

- Display sits flat
- All pins are aligned
- No bent pins

### Step 2 – Install the HDMI Jumper

Install the HDMI jumper adapter between the display and the Raspberry Pi Micro-HDMI port.

*Insert photo: HDMI jumper installed*

Notes:

- Adapter is directional
- Ensure both ends are fully seated
- Do not stress the adapter

### Step 3 – Install Standoffs

Verify:

- Display secured
- HDMI jumper not under tension
- Assembly rigid and stable

## Connect the Barcode Scanner

Connect the scanner to a USB port on the Pi.

## Connect Power

Use a right-angle USB-C cable.

Reason:

- The Pi power connector is on the side of the board.
- Straight USB-C connectors may not fit inside the enclosure.

## Cable Routing

The appliance operates in portrait orientation.

All external cables should exit through the bottom of the enclosure.

This includes:

- Scanner cable
- Network cable
- Future accessory cables

The USB-C cable enters from the side and immediately turns downward.

## Hardware Verification Checklist

- [ ] Display attached
- [ ] HDMI jumper installed
- [ ] Standoffs installed
- [ ] Scanner connected
- [ ] Right-angle USB-C cable installed
- [ ] SD card installed
- [ ] Display powers on

We will address the placement of the electronics assembly in the enclosure in a future update of this document.

---
## Software Installation Overview

This installation process will transform a brand-new Raspberry Pi into a Multimedica scanner appliance. We break it down into three phases, each with a distinct purpose:

1. We set up the Pi from scratch—flashing its operating system, connecting it to the network, and ensuring it’s ready for software.

2. We install the Multimedica Scanner software onto the Pi. This equips it with the scanner functionality, so it can interact with barcodes, the display, and the cloud—but it’s not yet assigned to a specific station.

3. We customize the scanner by assigning it to a specific station in the clinic. By scanning QR codes, we configure its network, cloud endpoint, and its exact role in the clinic (such as “Nursing Station 1” or “Lab Station”).

Throughout the instructions, we’ll guide you step-by-step, so you’ll know when we’re preparing the Pi, installing the software, or applying the final clinic-specific configuration.

# Phase A – Windows Workstation

## Generate Configuration QR Codes

Navigate to:

Admin → Sistema de escáner

Generate and print:

### WiFi Configuration QR

Contains:

- SSID
- Password
- Security type

### Cloud Configuration QR

Contains:

- Cloud endpoint configuration
- Shared secret

### Station Configuration QR

Contains:

- Location
- Station
- Room ID
- Device ID

Example:

- Location: Clínica Alfarero Z3
- Station: Enf
- Room ID: Zone3_nur_room_1
- Device ID: scanner_Zone3_nur_01

### Identity QR

Used to display:

- Device ID
- Room ID
- Station ID
- Hostname
- IP address
- Health URL
- Software version

Prepare an installation packet containing all four QR codes.


💡 **Tip**
```
The hostname and the Device ID serve different purposes. The hostname identifies the Raspberry Pi on the network. The Device ID identifies the scanner appliance within the Multimedica system. These values do not need to match, although many deployments choose a naming convention that keeps them similar.
```

## Install Raspberry Pi Imager

Download:

https://www.raspberrypi.com/software/

## Flash Raspberry Pi OS

Select:

- Raspberry Pi 4
- Raspberry Pi OS Lite (64-bit)

## Configure OS Customization

**Execution Context: [WINDOWS]**

When prompted to edit settings:

### General Settings

#### Hostname

Each scanner appliance must have a unique hostname.

Recommended format:

```text
multimedica-<station>-<number>
```

Examples:

```text
multimedica-reg-01
multimedica-nur-01
multimedica-doc-01
multimedica-lab-01
multimedica-pha-01
```

For multiple scanners of the same type:

```text
multimedica-nur-01
multimedica-nur-02
multimedica-nur-03
```

The hostname is used for:

* Initial network discovery
* SSH access
* Device identification
* Troubleshooting

Record the hostname on the deployment worksheet.

---

#### Username

```text
multimedica_edge
```

Use the same username on all scanner appliances.

---

#### Password

Choose a strong password.

Use the same password across the scanner fleet unless organizational policy requires otherwise.

Record the password securely.

---

### Deployment Worksheet

Record:

```text
Hostname:
IP Address:
Location:
Station:
Room ID:
Device ID:
```

This information will be useful for support and troubleshooting.


---

# Phase B – Raspberry Pi

## First Boot

Connect:

- Power
- Display
- Scanner
- Network

Power on the device.

## Verify Network Connectivity

[WINDOWS]

```powershell
ping <hostname>.local
```

## Connect Using SSH

[WINDOWS]

```powershell
ssh multimedica_edge@<hostname>.local
```

# Clone Repository

**Execution Context: [PI]**

Log into the Raspberry Pi using SSH.

Create the application folder:

```bash
sudo mkdir -p /opt
```

Move into the folder:

```bash
cd /opt
```

Clone the scanner repository:

```bash
sudo git clone https://github.com/paullmullen/multimedica-scanner.git
```

Verify that the repository was downloaded successfully:

```bash
ls -la /opt
```

Expected result:

```text
multimedica-scanner
```

Move into the application folder:

```bash
cd /opt/multimedica-scanner
```

Verify that application files are present:

```bash
ls
```

Expected output should include files similar to:

```text
scanner.js
package.json
provision-scanner.ps1
kiosk-display
README.md
```

> ⚠️ **Important**
>
> If the `git clone` command fails, verify:
>
> * Internet connectivity
> * DNS resolution
> * Access to github.com
>
> Test connectivity with:
>
> ```bash
> ping github.com
> ```


> 💡 **Tip**
>
> Now you have a working generic Raspberry Pi that can operate on your network. Next, we’ll turn it into a Multimedica scanner by installing the scanner software and services.

## Run Provisioning

Provisioning is the process of putting the clinic-specific software on the Raspberry pi.

[WINDOWS]

```powershell
.\provision-scanner.ps1 -InstallBasePackages -InstallSudoersPolicy
```

## Reboot

[PI]

```bash
sudo reboot
```
Wait for the Pi to reboot, which may take a minute or two. Once it’s back online, reconnect via SSH.

## Verify Services

[PI]

```bash
sudo systemctl status multimedica-scanner.service
sudo systemctl status kiosk-display.service
```

Expected:

active (running)

---
> 💡 **Tip**
>
> Now you have a scanner, not just a generic Raspberry Pi.  It's time to turn that generic scanner into a scanner for a specific station.  You're going to use the QR codes you generated earlier to complete this step.


# Phase C – Scanner Provisioning

## Configure WiFi

[SCANNER]

Scan the WiFi Configuration QR.

## Configure Cloud Connectivity

[SCANNER]

Scan the Cloud Configuration QR.

## Configure Station Assignment

[SCANNER]

Scan the Station Configuration QR.

## Verify Identity

[SCANNER]

Scan the Identity QR.

Verify:

- Device ID
- Room ID
- Station ID
- Hostname
- IP Address
- Health URL

---

# Phase D – Validation

## Verify Health Endpoint

[WINDOWS]

Open:

http://<scanner-ip>:3001/api/health

## Validate Scanner Operation

Scan a known patient ticket.

Verify:

- Display updates
- Cloud synchronization succeeds
- Workflow state changes correctly

---

# Updating an Existing Scanner

[WINDOWS]

```powershell
.\provision-scanner.ps1
```

---

# Troubleshooting

## Scanner Not Detected

[PI]

```bash
journalctl -u multimedica-scanner.service -f
```

## Display Not Running

[PI]

```bash
sudo systemctl restart kiosk-display.service
```

## Cloud Synchronization Failure

Verify:

- Internet connectivity
- Cloud QR scanned successfully
- Endpoint configuration is correct

---

# Device Replacement

1. Build a new appliance.
2. Reuse the existing QR packet.
3. Verify identity screen.
4. Verify health endpoint.
5. Test scanner operation.

---

# Operational Philosophy

The appliance is designed to be reproducible from:

- GitHub Production Branch
- Provisioning Script
- QR Configuration Packet

A replacement appliance should be deployable without source-code modifications.
