use super::Result;

pub fn set(enabled: bool, command: &[String]) -> Result<()> {
    if command.is_empty() || command[0].is_empty() {
        return Err("The startup command must include its executable".into());
    }
    set_platform(enabled, command)
}

#[cfg(target_os = "linux")]
fn set_platform(enabled: bool, command: &[String]) -> Result<()> {
    // auto-launch serializes Exec by joining strings. Quote at this format boundary.
    let encoded: Vec<_> = command.iter().map(|arg| desktop_argument(arg)).collect();
    let startup = auto_launch::AutoLaunch::new(
        "MusicFS",
        &encoded[0],
        auto_launch::LinuxLaunchMode::XdgAutostart,
        &encoded[1..],
    );
    if enabled {
        startup.enable()?;
    } else {
        startup.disable()?;
    }
    Ok(())
}

#[cfg(any(target_os = "linux", test))]
fn desktop_argument(value: &str) -> String {
    // The .desktop value layer and the Exec argument layer both process backslashes.
    let mut quoted = String::from("\"");
    for ch in value.chars() {
        match ch {
            '%' => quoted.push_str("%%"),
            '\\' => quoted.push_str("\\\\\\\\"),
            '"' | '$' | '`' => {
                quoted.push_str("\\\\");
                quoted.push(ch);
            }
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            _ => quoted.push(ch),
        }
    }
    quoted.push('"');
    quoted
}

#[cfg(target_os = "windows")]
fn set_platform(enabled: bool, command: &[String]) -> Result<()> {
    use windows_registry::CURRENT_USER;
    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    // auto-launch's disable also touches HKLM; use its mature registry dependency
    // directly to keep both operations within this user's MusicFS value.
    let startup = CURRENT_USER.create(KEY)?;
    if enabled {
        startup.set_string(
            "MusicFS",
            command
                .iter()
                .map(|arg| windows_argument(arg))
                .collect::<Vec<_>>()
                .join(" "),
        )?;
    } else if let Err(error) = startup.remove_value("MusicFS") {
        if error.code().0 as u32 != 0x80070002 {
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(any(target_os = "windows", test))]
fn windows_argument(value: &str) -> String {
    // Encode the standard CommandLineToArgvW/CRT backslash-and-quote convention.
    let mut quoted = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        quoted.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        quoted.push(ch);
        slashes = 0;
    }
    quoted.extend(std::iter::repeat_n('\\', slashes * 2));
    quoted.push('"');
    quoted
}

#[cfg(target_os = "macos")]
fn set_platform(enabled: bool, command: &[String]) -> Result<()> {
    use std::io::ErrorKind;
    let directory = dirs::home_dir()
        .ok_or("Cannot find the current user's home")?
        .join("Library/LaunchAgents");
    let file = directory.join("org.musicfs.desktop.plist");
    if enabled {
        std::fs::create_dir_all(&directory)?;
        let mut entry = plist::Dictionary::new();
        entry.insert("Label".into(), "org.musicfs.desktop".into());
        entry.insert(
            "ProgramArguments".into(),
            plist::Value::Array(command.iter().cloned().map(plist::Value::String).collect()),
        );
        entry.insert("RunAtLoad".into(), true.into());
        // plist owns XML serialization, including normal paths containing '&'.
        plist::Value::Dictionary(entry).to_file_xml(file)?;
    } else if let Err(error) = std::fs::remove_file(file) {
        if error.kind() != ErrorKind::NotFound {
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_and_arguments_keep_spaces_unicode_and_empty_values() {
        assert_eq!(
            windows_argument(r"C:\音乐 Files\MusicFS.exe"),
            r#""C:\音乐 Files\MusicFS.exe""#
        );
        assert_eq!(windows_argument(""), "\"\"");
        assert_eq!(windows_argument("C:\\Music FS\\"), "\"C:\\Music FS\\\\\"");
        assert_eq!(windows_argument("a\"b"), "\"a\\\"b\"");
        assert_eq!(
            desktop_argument("/home/音乐 Files/MusicFS"),
            "\"/home/音乐 Files/MusicFS\""
        );
        assert_eq!(desktop_argument("100% $x"), "\"100%% \\\\$x\"");
    }
}
