# Transparencia y materiales nativos: investigación

Fecha: 2026-09-08. Solo hallazgos; no constituye una propuesta, un plan de
implementación ni una prueba de compatibilidad de BetterComms.

## Qué efecto produce cada opción

| Opción | Apariencia y comportamiento |
| --- | --- |
| Transparencia | El canal alfa permite ver lo que hay detrás; por sí solo no desenfoca. |
| Mica | Material opaco que incorpora el tema y el fondo de escritorio. No muestra en vivo las ventanas que se mueven detrás. |
| Desktop Acrylic | Material translúcido con desenfoque del contenido situado detrás de la ventana. |
| Mica Alt | Variante de Mica con mayor énfasis en el fondo de escritorio, asociada a superficies con pestañas. |

Microsoft distingue [Mica](https://learn.microsoft.com/en-us/windows/apps/design/style/mica)
de [Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic).
El estado de activación, ahorro de energía, alto contraste y preferencias de
transparencia pueden afectar al material o llevarlo a un fondo sólido. No se
puede asumir que todos los equipos muestran siempre el mismo efecto.

## Windows SDK y Windows App SDK

La API Win32 documentada `DwmSetWindowAttribute`, con
`DWMWA_SYSTEMBACKDROP_TYPE`, permite seleccionar el fondo del HWND. La enumeración
`DWM_SYSTEMBACKDROP_TYPE` está documentada desde Windows 11 build 22621:
`DWMSBT_MAINWINDOW` corresponde actualmente a Mica, `DWMSBT_TRANSIENTWINDOW` a
Desktop Acrylic y `DWMSBT_TABBEDWINDOW` a Mica Alt. Son categorías semánticas;
Microsoft puede ajustar su representación en otras versiones de Windows.
[Referencia del SDK](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type).

Windows App SDK también ofrece superficies como `Window.SystemBackdrop` y
`DesktopAcrylicBackdrop` para aplicaciones WinUI. Son una capa distinta de las
funciones Win32 del Windows SDK; la existencia de esas APIs no obliga a convertir
una aplicación Tauri en WinUI para acceder a materiales nativos.
[Referencia de Acrylic](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic).

## Qué ofrece Tauri

Tauri 2 documenta `transparent` y `windowEffects`, con efectos como `mica`,
`acrylic` y `tabbed`. Su configuración exige transparencia de ventana para los
efectos y describe límites por plataforma. Por tanto, esta parte sí tiene una
superficie documentada en Tauri, aunque el overlay experimental de botones del
crate sea una integración independiente.
[Configuración oficial](https://v2.tauri.app/reference/config/#windoweffectsconfig).

El proyecto oficial `window-vibrancy` documenta problemas de rendimiento de
blur/acrylic durante arrastre y redimensionamiento en determinadas versiones de
Windows. En macOS expone materiales de `NSVisualEffectView`; Linux no tiene
soporte en ese crate y los efectos dependen del compositor del usuario. Esa
matriz no demuestra el rendimiento de BetterComms en una llamada o captura.
[Compatibilidad de window-vibrancy](https://github.com/tauri-apps/window-vibrancy).

## Situación observada en este repositorio

La ventana principal no activa `transparent` ni `windowEffects`.
`better-gui/src/windows.rs` configura bordes, esquinas y modo oscuro mediante
DWM, pero fija el alfa del fondo del overlay en 255. El frontend también pinta
sus propias superficies. Esas capas opacas ocultarían un material situado debajo;
activar un fondo del HWND no demuestra que el efecto resulte visible en la app.

La API experimental de [Window Controls Overlay](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2windowcontrolsoverlay?view=webview2-winrt-1.0.3712-prerelease)
documenta transparencia en `BackgroundColor`. Esto es una capacidad declarada
de la API, no una validación de su combinación con DWM, WebView2 y el marco
personalizado de BetterComms.

No se han modificado materiales, colores, configuración de transparencia,
dependencias de efectos ni el diseño del frontend como parte de esta investigación.
