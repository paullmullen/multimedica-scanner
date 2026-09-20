# Deploy a Scanner from the Prebuilt SD-Card Image

**Audience:** Clinic installer

**Purpose:** Put a complete Multimédica scanner installation on a microSD card without using SSH or running the engineering provisioning procedure

---

## 1. What you will do

1. Write the supplied image to the microSD card.
2. Insert the card and power on the scanner.
3. Scan the Wi-Fi configuration QR.
4. Scan the station configuration QR.
5. Scan the cloud configuration QR.
6. Scan a designated test-patient barcode.

The image already contains the operating system, scanner services, display software, and approved production release. The appliance performs its internal first-boot setup automatically. The installer does not configure Linux, SSH, keys, users, hostnames, services, or application files.

The image does not contain a clinic's Wi-Fi password, station identity, cloud endpoint, or clinic shared secret. Those values arrive through the approved configuration QRs.

---

## 2. Required items

- Raspberry Pi 4 scanner appliance
- 32 GB or larger high-quality microSD card
- Current approved scanner image. The first approved image is `mmscanner20260918.img.xz`.
- Matching `.sha256` checksum file
- Raspberry Pi Imager on Windows
- Approved Wi-Fi, station, and cloud configuration QRs
- Designated test-patient barcode

---

## 3. Verify the image

Keep the image and checksum file in the same folder. In Windows PowerShell, run:

```powershell
$image = Get-Item .\mmscanner20260918.img.xz
$expected = ((Get-Content "$($image.FullName).sha256" -Raw).Trim() -split '\s+')[0]
$actual = (Get-FileHash $image.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"Expected: $expected"
"Actual:   $actual"
if ($actual -ne $expected) { throw "Image checksum does not match." }
```

The two values must be identical. Stop if they differ.

---

## 4. Write the microSD card

1. Open **Raspberry Pi Imager**.
2. Select **Raspberry Pi 4**.
3. Click **Choose OS**, choose **Use custom**, and select `mmscanner20260918.img.xz`.
4. Select the intended microSD card.
5. If Raspberry Pi Imager offers to apply operating-system customization, choose **No**. The image already contains the required operating-system and scanner configuration.
6. Click **Write** and approve the erase warning.
7. Wait for writing and verification to finish successfully.
8. Eject the card safely.

Writing the image erases the selected storage device. Verify that the selected device is the microSD card.

---

## 5. Start and configure the scanner

1. Disconnect power from the scanner appliance.
2. Insert the microSD card.
3. Connect the barcode scanner and display.
4. Apply power.
5. Allow up to three minutes for the first startup.
6. When prompted by the display, scan the configuration QRs in this order:
   1. Wi-Fi
   2. Station
   3. Cloud
7. Wait for the green confirmation overlay after each QR before scanning the next. Each overlay remains visible for approximately five seconds:
   - **Wi‑Fi configurado**
   - **Estación configurada**
   - **Nube configurada**
8. Scan the designated test-patient barcode and confirm the expected result.
9. Perform one controlled power cycle and confirm that the scanner returns to normal operation.

Do not use a real patient's barcode for installation testing.

---

## 6. Acceptance checklist

- [ ] Image checksum matched
- [ ] Image write and verification completed without error
- [ ] Scanner display started normally
- [ ] Wi-Fi QR accepted
- [ ] Station QR accepted
- [ ] Cloud QR accepted
- [ ] Correct clinic and station state displayed
- [ ] Test-patient scan produced the expected result
- [ ] Controlled power-cycle test passed

For failures after the card has been written, see [Troubleshooting](troubleshooting.md). The longer [Scanner Appliance Installation Guide](installation.md) remains the engineering, repair, and reference-image procedure.
