# Personal Vault

Personal Vault is a local-first desktop app for keeping credentials and other private details in one encrypted place. It is built with Tauri, React, TypeScript, and the Web Crypto API.

## Features

- Store logins, payment cards, identity details, secure notes, API keys, SSH keys, Wi-Fi credentials, and custom entries.
- Add notes, tags, and any number of extra fields; mark custom fields as secret.
- Search across your saved entries, filter by category, and pin favorites.
- Use keyboard shortcuts to search (Ctrl/Cmd+K), add an item (Ctrl/Cmd+N), or lock the vault (Ctrl/Cmd+L). Dialogs support Tab and Escape.
- Generate random passwords, reveal or copy secrets, and automatically clear copied values after 30 seconds when clipboard permissions allow.
- Lock the vault manually or after five minutes of inactivity.
- Change the authenticator from the unlocked vault after scanning and confirming a new setup code.
- Export and restore an encrypted JSON backup.
- Unlock with a master password, a TOTP authenticator code, and a device key held in the operating system credential store.

## Security model

Vault contents are encrypted in the app before they are written to the local application data directory. The encryption key is derived from the master password with PBKDF2-HMAC-SHA-256 (600,000 iterations) and combined with a random device key using HKDF-SHA-256. The device key is stored in the OS credential store (Windows Credential Manager, macOS Keychain, or Linux Secret Service). AES-256-GCM uses a fresh random nonce for every save. On Unix-like systems, the vault directory and file are restricted to the current user.

The TOTP code is an additional local sign-in check; it is not an independent encryption factor. The master password and OS-held device key protect a copied vault file. This offline app cannot remotely verify TOTP codes. OS credential stores may not require a biometric prompt on every access, so device-key protection depends on the security of your logged-in OS account.

Encrypted backups are tied to the device key and can only be restored where that key is available. The master password, authenticator, and device key have no recovery service. You can replace an authenticator only while the vault is unlocked; losing access after the vault is locked can make it inaccessible. Keep your authenticator setup key safe. There is no account, cloud sync, or network service.

On Linux, an unlocked Secret Service provider such as GNOME Keyring or KWallet is required. The OS credential store may not prompt for biometrics; the app uses the platform's credential-store access rules.

## Run locally

Install Node.js, Rust, and the system dependencies required by Tauri for your operating system, then run:

```sh
npm install
npm run tauri dev
```

Create a distributable desktop app with:

```sh
npm run tauri build
```
