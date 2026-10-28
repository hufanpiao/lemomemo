// arch-fixture: path=src/features/reminders/ui/Bad.tsx expect=no-restricted-globals
// 违规：Notification 只能写在 platform
export const ask = () => Notification.requestPermission();
