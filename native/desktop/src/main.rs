#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod browser;
mod startup;

use serde::Deserialize;
use std::io::{self, BufRead, Write};
use tray_icon::{
    menu::{Menu, MenuEvent, MenuItem},
    Icon, MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

#[derive(Deserialize)]
struct StartupRequest {
    enabled: bool,
    command: Vec<String>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("tray") => run_tray(),
        Some("autostart") => {
            let request: StartupRequest = serde_json::from_reader(io::stdin().lock())?;
            startup::set(request.enabled, &request.command)?;
            emit(serde_json::json!({ "type": "autostart", "enabled": request.enabled }));
            Ok(())
        }
        #[cfg(target_os = "windows")]
        Some("open-url") => {
            let url: String = serde_json::from_reader(io::stdin().lock())?;
            browser::open(&url)
        }
        _ => Err("Usage: desktop-helper tray|autostart|open-url (Windows)".into()),
    }
}

fn emit(event: serde_json::Value) {
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let _ = writeln!(output, "{event}");
    let _ = output.flush();
}

fn emit_action(action: &str) {
    emit(serde_json::json!({ "type": "action", "action": action }));
}

fn create_tray() -> Result<TrayIcon> {
    let menu = Menu::new();
    menu.append_items(&[
        &MenuItem::with_id("open", "打开管理页面", true, None),
        &MenuItem::with_id("phone", "手机访问", true, None),
        &MenuItem::with_id("quit", "退出 MusicFS", true, None),
    ])?;
    // A transparent music note stays legible in both light and dark system trays.
    let mut rgba = vec![0; 32 * 32 * 4];
    for y in 0..32 {
        for x in 0..32 {
            let stem = (13..16).contains(&x) && (8..24).contains(&y)
                || (25..28).contains(&x) && (5..21).contains(&y);
            let beam = (13..28).contains(&x) && (5..11).contains(&y) && y >= 5 + (27 - x) / 5;
            let left = (x as i32 - 10).pow(2) + (y as i32 - 24).pow(2) <= 21;
            let right = (x as i32 - 22).pow(2) + (y as i32 - 21).pow(2) <= 21;
            if stem || beam || left || right {
                let offset = (y * 32 + x) * 4;
                rgba[offset..offset + 4].copy_from_slice(&[0, 150, 136, 255]);
            }
        }
    }
    let icon = Icon::from_rgba(rgba, 32, 32)?;
    let builder = TrayIconBuilder::new()
        .with_id("org.musicfs.desktop")
        .with_tooltip("MusicFS")
        .with_menu(Box::new(menu));
    #[cfg(target_os = "macos")]
    let builder = builder.with_icon_templated(icon);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.with_icon(icon).with_menu_on_left_click(false);
    Ok(builder.build()?)
}

fn handle_menu(event: MenuEvent) {
    match event.id.as_ref() {
        "open" | "phone" | "quit" => emit_action(event.id.as_ref()),
        _ => {}
    }
}

fn handle_icon(event: TrayIconEvent) {
    if opens_management(&event, cfg!(target_os = "windows")) {
        emit_action("open");
    }
}

fn opens_management(event: &TrayIconEvent, double_click: bool) -> bool {
    if double_click {
        return matches!(
            event,
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }
        );
    }
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

#[cfg(test)]
mod tray_tests {
    use super::*;

    #[test]
    fn windows_double_click_sequence_opens_exactly_once() {
        let click = |button_state| TrayIconEvent::Click {
            id: "test".into(),
            position: Default::default(),
            rect: Default::default(),
            button: MouseButton::Left,
            button_state,
        };
        let double = TrayIconEvent::DoubleClick {
            id: "test".into(),
            position: Default::default(),
            rect: Default::default(),
            button: MouseButton::Left,
        };
        let sequence = [
            click(MouseButtonState::Down),
            click(MouseButtonState::Up),
            double,
            click(MouseButtonState::Up),
        ];
        assert!(!opens_management(&sequence[1], true));
        assert!(opens_management(&sequence[2], true));
        assert_eq!(
            sequence
                .iter()
                .filter(|event| opens_management(event, true))
                .count(),
            1
        );
        // Other tray backends expose activation clicks rather than Windows double clicks.
        assert!(opens_management(&sequence[1], false));
    }
}

fn watch_parent(on_closed: impl FnOnce() + Send + 'static) {
    std::thread::spawn(move || {
        // The pipe closes even when the Bun parent is killed, so no orphan tray remains.
        for line in io::stdin().lock().lines() {
            if line.is_err() {
                break;
            }
        }
        on_closed();
    });
}

#[cfg(target_os = "linux")]
fn run_tray() -> Result<()> {
    MenuEvent::set_event_handler(Some(handle_menu));
    TrayIconEvent::set_event_handler(Some(handle_icon));
    let tray = create_tray()?;
    emit(serde_json::json!({ "type": "ready" }));
    let (closed, receiver) = std::sync::mpsc::channel();
    watch_parent(move || {
        let _ = closed.send(());
    });
    let _ = receiver.recv();
    drop(tray);
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run_tray() -> Result<()> {
    use tao::{
        event::{Event, StartCause},
        event_loop::{ControlFlow, EventLoopBuilder},
    };
    let event_loop = EventLoopBuilder::<()>::with_user_event().build();
    #[cfg(target_os = "macos")]
    let event_loop = {
        use tao::platform::macos::{ActivationPolicy, EventLoopExtMacOS};
        let mut event_loop = event_loop;
        event_loop.set_activation_policy(ActivationPolicy::Accessory);
        event_loop.set_dock_visibility(false);
        event_loop.set_activate_ignoring_other_apps(false);
        event_loop
    };
    MenuEvent::set_event_handler(Some(handle_menu));
    TrayIconEvent::set_event_handler(Some(handle_icon));
    let proxy = event_loop.create_proxy();
    watch_parent(move || {
        let _ = proxy.send_event(());
    });
    let mut tray = None;
    // macOS requires creation after the main-thread application loop starts.
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::NewEvents(StartCause::Init) => match create_tray() {
                Ok(icon) => {
                    tray = Some(icon);
                    emit(serde_json::json!({ "type": "ready" }));
                    #[cfg(target_os = "macos")]
                    if let Some(main) = objc2_core_foundation::CFRunLoop::main() {
                        objc2_core_foundation::CFRunLoop::wake_up(&main);
                    }
                }
                Err(error) => {
                    eprintln!("{error}");
                    *flow = ControlFlow::ExitWithCode(1);
                }
            },
            Event::UserEvent(()) => {
                tray.take();
                *flow = ControlFlow::Exit;
            }
            Event::LoopDestroyed => {
                tray.take();
            }
            _ => {}
        }
    })
}
