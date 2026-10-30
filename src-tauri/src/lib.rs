use keyring::{Entry, Error as KeyringError};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::PathBuf,
};
use tauri::Manager;

const KEYRING_SERVICE: &str = "com.personalvault.desktop";

fn validate_envelope(contents: &str) -> Result<(), String> {
    let envelope: serde_json::Value = serde_json::from_str(contents)
        .map_err(|_| "Vault data must be a valid encrypted vault file.".to_string())?;
    let version = envelope.get("version").and_then(serde_json::Value::as_u64);
    let kdf = envelope.get("kdf").and_then(serde_json::Value::as_str);
    let valid_common = envelope
        .get("iterations")
        .and_then(serde_json::Value::as_u64)
        .is_some_and(|iterations| (1..=1_000_000).contains(&iterations))
        && ["salt", "iv", "ciphertext"].iter().all(|field| {
            envelope
                .get(field)
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.is_empty())
        });
    let valid = valid_common
        && ((version == Some(1) && kdf == Some("PBKDF2-SHA-256"))
            || (version == Some(2)
                && kdf == Some("PBKDF2-HKDF-SHA-256")
                && envelope
                    .get("vaultId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|vault_id| !vault_id.is_empty() && vault_id.len() <= 64)));
    if valid {
        Ok(())
    } else {
        Err("Only encrypted Personal Vault files can be saved.".to_string())
    }
}

#[tauri::command]
fn store_unlock_factors(
    vault_id: String,
    device_key: String,
    totp_secret: String,
) -> Result<(), String> {
    if vault_id.is_empty()
        || vault_id.len() > 64
        || device_key.len() != 44
        || totp_secret.len() != 32
    {
        return Err("The unlock factors are invalid.".to_string());
    }
    let entry = Entry::new(KEYRING_SERVICE, &vault_id)
        .map_err(|error| format!("Could not access the OS credential store: {error}"))?;
    let factors = serde_json::json!({
        "deviceKey": device_key,
        "totpSecret": totp_secret
    });
    entry.set_password(&factors.to_string()).map_err(|error| {
        format!("Could not store unlock factors in the OS credential store: {error}")
    })
}

#[tauri::command]
fn read_unlock_factors(vault_id: String) -> Result<Option<serde_json::Value>, String> {
    if vault_id.is_empty() || vault_id.len() > 64 {
        return Err("The vault identifier is invalid.".to_string());
    }
    let entry = Entry::new(KEYRING_SERVICE, &vault_id)
        .map_err(|error| format!("Could not access the OS credential store: {error}"))?;
    let serialized = match entry.get_password() {
        Ok(serialized) => serialized,
        Err(KeyringError::NoEntry) => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Could not read unlock factors from the OS credential store: {error}"
            ))
        }
    };
    let factors: serde_json::Value = serde_json::from_str(&serialized)
        .map_err(|_| "The saved unlock factors are invalid.".to_string())?;
    let valid = factors
        .get("deviceKey")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value.len() == 44)
        && factors
            .get("totpSecret")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value.len() == 32);
    if !valid {
        return Err("The saved unlock factors are invalid.".to_string());
    }
    Ok(Some(factors))
}

#[tauri::command]
fn update_totp_secret(vault_id: String, totp_secret: String) -> Result<(), String> {
    if totp_secret.len() != 32
        || !totp_secret
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
    {
        return Err("The authenticator secret is invalid.".to_string());
    }
    let Some(mut factors) = read_unlock_factors(vault_id.clone())? else {
        return Err(
            "The saved unlock factors could not be found; the authenticator was not changed."
                .to_string(),
        );
    };
    let Some(factors) = factors.as_object_mut() else {
        return Err("The saved unlock factors are invalid.".to_string());
    };
    factors.insert(
        "totpSecret".to_string(),
        serde_json::Value::String(totp_secret),
    );
    let serialized = serde_json::to_string(&factors)
        .map_err(|error| format!("Could not update the saved authenticator: {error}"))?;
    let entry = Entry::new(KEYRING_SERVICE, &vault_id)
        .map_err(|error| format!("Could not access the OS credential store: {error}"))?;
    entry.set_password(&serialized).map_err(|error| {
        format!("Could not save the new authenticator in the OS credential store: {error}")
    })
}

fn vault_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate app data directory: {error}"))?;
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not prepare vault storage: {error}"))?;
    set_private_permissions(&directory, true)?;
    Ok(directory.join("vault.json"))
}

#[cfg(unix)]
fn set_private_permissions(path: &std::path::Path, directory: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if directory { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|error| format!("Could not secure vault file permissions: {error}"))
}

#[cfg(not(unix))]
fn set_private_permissions(_path: &std::path::Path, _directory: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn read_vault(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = vault_path(&app)?;
    let backup = path.with_file_name("vault.json.bak");
    if !path.exists() && backup.exists() {
        fs::rename(&backup, &path)
            .map_err(|error| format!("Could not recover the encrypted vault: {error}"))?;
    }
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read the encrypted vault: {error}")),
    }
}

#[tauri::command]
fn write_vault(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    validate_envelope(&contents)?;
    let path = vault_path(&app)?;
    let directory = path
        .parent()
        .ok_or_else(|| "Could not locate vault storage directory.".to_string())?;
    let temporary = directory.join("vault.json.tmp");
    let backup = directory.join("vault.json.bak");

    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create encrypted vault file: {error}"))?;
    set_private_permissions(&temporary, false)?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("Could not write encrypted vault file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush encrypted vault file: {error}"))?;
    drop(file);

    if path.exists() {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("Could not rotate vault backup: {error}"))?;
        }
        fs::rename(&path, &backup)
            .map_err(|error| format!("Could not preserve existing vault: {error}"))?;
    }

    if let Err(error) = fs::rename(&temporary, &path) {
        if backup.exists() {
            let _ = fs::rename(&backup, &path);
        }
        return Err(format!("Could not save encrypted vault: {error}"));
    }

    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    if let Ok(directory_file) = File::open(directory) {
        let _ = directory_file.sync_all();
    }
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_vault,
            write_vault,
            store_unlock_factors,
            read_unlock_factors,
            update_totp_secret
        ])
        .run(tauri::generate_context!())
        .expect("error while running Personal Vault");
}
