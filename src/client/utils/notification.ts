/**
 * Browser Notification API utilities for session status alerts.
 */

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNotificationSupported()) return 'denied'
  return Notification.requestPermission()
}

export function getNotificationPermission(): NotificationPermission {
  if (!isNotificationSupported()) return 'denied'
  return Notification.permission
}

export function showNotification(title: string, options?: NotificationOptions): Notification | null {
  if (!isNotificationSupported()) return null
  if (Notification.permission !== 'granted') return null
  try {
    return new Notification(title, {
      icon: '/favicon.ico',
      ...options,
    })
  } catch {
    return null
  }
}
