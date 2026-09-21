package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/services/notifications"
)

// NotificationResponseEvent carries a clicked notification back to the page.
//
// The service itself is bound straight through to the frontend, which is what
// sends the toasts; this is the one direction bindings cannot cover, because a
// click arrives in the host while the window may be minimised or behind
// something else.
const NotificationResponseEvent = "desktop:notification-response"

// attachNotifications brings the window forward when somebody clicks a toast,
// and tells the page which one it was.
//
// The page decides what that means — opening the conversation the message came
// from, or the room that is calling — from the Data it attached when it sent
// the notification. The host stays out of it: it knows about windows, not
// about conversations.
func attachNotifications(
	service *notifications.NotificationService,
	window *application.WebviewWindow,
) {
	if service == nil || window == nil {
		return
	}
	service.OnNotificationResponse(func(result notifications.NotificationResult) {
		if result.Error != nil {
			return
		}
		// Restore first: a minimised window cannot take focus, and a toast is
		// most often clicked precisely because the window was not in front.
		window.Restore()
		window.Show()
		window.Focus()
		window.EmitEvent(NotificationResponseEvent, result.Response)
	})
}
