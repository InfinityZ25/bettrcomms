//! DXGI ordinals, rather than WMI list positions, select DirectML adapters.
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapter {
    pub index: i32,
    pub name: String,
    pub vendor_id: u32,
}

#[cfg(windows)]
pub fn compatible_adapters() -> Result<Vec<GpuAdapter>, String> {
    use windows::Win32::Graphics::Dxgi::{
        CreateDXGIFactory1, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, DXGI_ERROR_NOT_FOUND,
    };
    // DXGI owns each COM reference. No raw pointers survive this function.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| e.to_string())?;
        let mut adapters = Vec::new();
        for index in 0..32 {
            let adapter = match factory.EnumAdapters1(index) {
                Ok(adapter) => adapter,
                Err(error) if error.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(error) => return Err(error.to_string()),
            };
            let desc = adapter.GetDesc1().map_err(|e| e.to_string())?;
            if desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0
                || !matches!(desc.VendorId, 0x1002 | 0x8086)
            {
                continue;
            }
            let len = desc
                .Description
                .iter()
                .position(|v| *v == 0)
                .unwrap_or(desc.Description.len());
            adapters.push(GpuAdapter {
                index: index as i32,
                name: String::from_utf16_lossy(&desc.Description[..len]),
                vendor_id: desc.VendorId,
            });
        }
        Ok(adapters)
    }
}

#[cfg(not(windows))]
pub fn compatible_adapters() -> Result<Vec<GpuAdapter>, String> {
    Ok(Vec::new())
}

pub fn preferred_adapter() -> Result<GpuAdapter, String> {
    let mut adapters = compatible_adapters()?;
    adapters.sort_by_key(|adapter| (adapter.vendor_id != 0x1002, adapter.index));
    adapters
        .into_iter()
        .next()
        .ok_or_else(|| "No AMD or Intel graphics adapter is available for DirectML.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires the installed AMD or Intel graphics driver"]
    fn installed_adapter_has_native_dxgi_ordinal() {
        let adapter = preferred_adapter().unwrap();
        assert!(matches!(adapter.vendor_id, 0x1002 | 0x8086));
        println!("DirectML adapter {}: {}", adapter.index, adapter.name);
    }
}
