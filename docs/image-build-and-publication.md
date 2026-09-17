# Build and Publish the Scanner SD-Card Image

**Audience:** Release owner

**Purpose:** Create a reusable image from a physically accepted reference appliance

---

## 1. Image model

The image is captured from a known-good Raspberry Pi after the complete scanner installation and approved production release have passed physical acceptance. The preparation script then removes clinic-specific configuration and cloned operating-system identity.

It retains the QR authorization material and approved production release. Treat the image as a controlled deployment artifact; do not publish it in the public source repository.

---

## 2. Prepare the reference appliance

1. Use the qualified Raspberry Pi 4 hardware and operating-system baseline.
2. Follow the full [Scanner Appliance Installation Guide](installation.md).
3. Install the approved production release.
4. Complete the physical display, QR, test-patient, and power-cycle acceptance checks.
5. Update the repository on the reference appliance so it contains the `image` directory.

From the repository root on the reference appliance, run:

```bash
sudo bash image/prepare-golden-image.sh
sudo systemctl poweroff
```

Do not reboot the reference card before capturing it. Rebooting intentionally performs the automatic first-boot initialization.

---

## 3. Capture and compress the card

Use a trusted disk-imaging workstation to read the entire source card into:

```text
multimedica-scanner-<image-version>.img
```

Compress it and create its checksum:

```bash
xz -T0 -9 -k multimedica-scanner-<image-version>.img
sha256sum multimedica-scanner-<image-version>.img.xz \
  > multimedica-scanner-<image-version>.img.xz.sha256
```

The target card must have at least as many bytes as the reference card, even when both are sold as the same nominal size. Prefer one standardized card model for reference and field installations.

---

## 4. Validate on a second appliance

Write the candidate image to a different card and Raspberry Pi using [Deploy a Scanner from the Prebuilt SD-Card Image](image-deployment.md).

Require:

- checksum verification;
- first boot without manual Linux or SSH configuration;
- no retained clinic Wi-Fi, station, or cloud configuration;
- successful Wi-Fi, station, and cloud QR scans;
- correct approved production release;
- successful test-patient scan; and
- successful controlled power cycle.

The release owner should additionally confirm that the clone received a unique machine identity and maintenance host keys. These are engineering acceptance checks, not field-installer tasks.

---

## 5. Store the release set

Store these items together in the controlled deployment location:

```text
multimedica-scanner-<image-version>.img.xz
multimedica-scanner-<image-version>.img.xz.sha256
multimedica-scanner-<image-version>-release-notes.md
```

The release notes must identify the image version, source commit, Raspberry Pi OS build, bootstrap version, production release version, reference-card model and byte capacity, validation date, and physical acceptance owner.
