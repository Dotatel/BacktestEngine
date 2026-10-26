use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceStyle {
    #[default]
    Simple,
    Advanced,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Codex,
    Claude,
    Opencode,
}

/// Versioned local setup state. It stores no credentials or account metadata.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub version: u8,
    pub step: u8,
    pub completed: bool,
    pub workspace_style: WorkspaceStyle,
    pub appearance: Appearance,
    pub agent: Option<AgentProvider>,
    pub agent_verified: bool,
}

impl Default for Preferences {
    /// Start a first-run setup without connecting an agent or changing system settings.
    fn default() -> Self {
        Self {
            version: 1,
            step: 1,
            completed: false,
            workspace_style: WorkspaceStyle::Simple,
            appearance: Appearance::System,
            agent: None,
            agent_verified: false,
        }
    }
}

impl Preferences {
    /// Reject unsupported versions and contradictory progress before any disk write.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 || !(1..=5).contains(&self.step) {
            return Err("Saved setup has an unsupported version or step.".into());
        }
        if self.completed && self.step != 5 {
            return Err("Complete the final setup step before finishing.".into());
        }
        if self.agent_verified && self.agent != Some(AgentProvider::Opencode) {
            return Err("Only a verified OpenCode service can be marked connected.".into());
        }
        Ok(())
    }
}

/// Own one local settings file. The host mutex serializes all reads and writes.
pub struct PreferenceStore {
    pub path: PathBuf,
}

impl PreferenceStore {
    /// Read validated state; missing files mean first launch, while corrupt files are preserved.
    pub fn load(&self) -> Result<Preferences, String> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Preferences::default()),
            Err(_) => return Err("Your saved setup could not be read. Check access to the app settings folder and retry.".into()),
        };
        let value: Preferences = serde_json::from_slice(&bytes)
            .map_err(|_| "Your saved setup is damaged. Retry, or reset setup to keep a backup and start again.".to_string())?;
        value.validate()?;
        Ok(value)
    }

    /// Atomically replace validated setup using a same-directory temporary file; failures retain the old file.
    pub fn save(&self, value: &Preferences) -> Result<(), String> {
        value.validate()?;
        let parent = self
            .path
            .parent()
            .ok_or("The app settings path is invalid.")?;
        fs::create_dir_all(parent).map_err(|_| "The app settings folder cannot be created. Check available space and folder access.".to_string())?;
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|_| "Your setup could not be prepared for saving.".to_string())?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|_| {
            "Your setup could not be saved. Check available space and folder access.".to_string()
        })?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|_| {
                "Your setup could not be written. Free some disk space and retry.".to_string()
            })?;
        temporary.persist(&self.path).map_err(|_| "Your setup could not replace the previous settings. Close any app using that file and retry.".to_string())?;
        Ok(())
    }

    /// On an explicit reset, preserve the old file beside the new defaults; never touch projects.
    pub fn reset(&self) -> Result<Preferences, String> {
        if self.path.exists() {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| "The system clock could not be read.".to_string())?
                .as_nanos();
            fs::rename(
                &self.path,
                self.path.with_extension(format!("backup-{stamp}.json")),
            )
            .map_err(|_| {
                "The old settings could not be backed up. Check folder access and retry."
                    .to_string()
            })?;
        }
        let value = Preferences::default();
        self.save(&value)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Give each test an isolated settings file, removed with its temporary directory.
    fn store() -> (tempfile::TempDir, PreferenceStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = PreferenceStore {
            path: directory.path().join("setup.json"),
        };
        (directory, store)
    }

    #[test]
    /// Missing state starts at Welcome with no agent and System appearance.
    fn first_launch_defaults() {
        let (_directory, store) = store();
        assert_eq!(store.load().unwrap(), Preferences::default());
    }

    #[test]
    /// Save can replace an existing file and persist the selected setup across fresh store instances.
    fn replaces_and_roundtrips_progress() {
        let (_directory, store) = store();
        store.save(&Preferences::default()).unwrap();
        let next = Preferences {
            step: 4,
            workspace_style: WorkspaceStyle::Advanced,
            appearance: Appearance::Dark,
            ..Preferences::default()
        };
        store.save(&next).unwrap();
        assert_eq!(
            PreferenceStore {
                path: store.path.clone()
            }
            .load()
            .unwrap(),
            next
        );
    }

    #[test]
    /// Contradictory or unsupported state is rejected without damaging valid prior settings.
    fn rejects_invalid_state_before_writing() {
        let (_directory, store) = store();
        let valid = Preferences::default();
        store.save(&valid).unwrap();
        for invalid in [
            Preferences {
                step: 0,
                ..valid.clone()
            },
            Preferences {
                version: 2,
                ..valid.clone()
            },
            Preferences {
                completed: true,
                ..valid.clone()
            },
            Preferences {
                agent_verified: true,
                agent: Some(AgentProvider::Codex),
                ..valid.clone()
            },
        ] {
            assert!(store.save(&invalid).is_err());
            assert_eq!(store.load().unwrap(), valid);
        }
    }

    #[test]
    /// Corrupt settings remain byte-identical until explicit reset, which preserves a backup.
    fn corruption_requires_explicit_recovery() {
        let (directory, store) = store();
        fs::write(&store.path, "broken-json").unwrap();
        assert!(store.load().is_err());
        assert_eq!(fs::read_to_string(&store.path).unwrap(), "broken-json");
        assert_eq!(store.reset().unwrap(), Preferences::default());
        let backup = fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name().to_string_lossy().contains("backup-"))
            .unwrap();
        assert_eq!(fs::read_to_string(backup.path()).unwrap(), "broken-json");
    }

    #[test]
    /// Enum and unknown-field validation prevent silently accepting malformed stored choices.
    fn rejects_unknown_preferences() {
        let (_directory, store) = store();
        let mut value = serde_json::to_value(Preferences::default()).unwrap();
        value["appearance"] = "sepia".into();
        fs::write(&store.path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(store.load().is_err());
        value["appearance"] = "dark".into();
        value["secret"] = "unexpected".into();
        fs::write(&store.path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(store.load().is_err());
    }

    #[test]
    /// A blocked parent path reports a recoverable write error rather than a false success.
    fn reports_storage_failure() {
        let directory = tempfile::tempdir().unwrap();
        let blocked = directory.path().join("not-a-directory");
        fs::write(&blocked, "keep").unwrap();
        let store = PreferenceStore {
            path: blocked.join("setup.json"),
        };
        assert!(store.save(&Preferences::default()).is_err());
        assert_eq!(fs::read_to_string(blocked).unwrap(), "keep");
    }
}
