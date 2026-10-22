use super::Result;
use std::ptr::{null, null_mut};
use windows_sys::Win32::{
    System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    },
    UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};

/// The GUI helper asks the system's default URL handler directly; no console shell is started.
pub fn open(url: &str) -> Result<()> {
    let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
    // Shell extensions can use COM. This short-lived helper owns this thread's initialization.
    let initialized = unsafe {
        CoInitializeEx(
            null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    if initialized < 0 {
        return Err(format!("Cannot initialize the browser opener ({initialized:#x})").into());
    }
    let result = unsafe {
        ShellExecuteW(
            null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    } as isize;
    unsafe { CoUninitialize() };
    if result <= 32 {
        return Err(format!("Cannot open the default browser (ShellExecute {result})").into());
    }
    Ok(())
}
