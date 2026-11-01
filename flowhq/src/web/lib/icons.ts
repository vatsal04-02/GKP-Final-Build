// Registry icon names -> lucide icons (the registries in src/core stay free of UI libraries).
import {
  Activity, AlarmClock, AlertTriangle, BarChart3, Bell, Calendar, CalendarClock, CalendarPlus, CalendarX, CreditCard, FileBarChart, FileText, Hand,
  HeartPulse, Inbox, LayoutDashboard, LineChart, ListChecks, Megaphone, MessageCircle, Repeat, Reply, Send, Settings, SkipForward, Sparkles, Star,
  Target, UserCog, UserPlus, Users, Workflow, UserRound, ClipboardList, Receipt, CalendarCheck, UserCheck, type LucideIcon,
} from 'lucide-react';
export const ICONS: Record<string, LucideIcon> = {
  'layout-dashboard': LayoutDashboard, inbox: Inbox, users: Users, calendar: Calendar, workflow: Workflow, 'list-checks': ListChecks,
  'bar-chart': BarChart3, activity: Activity, sparkles: Sparkles, settings: Settings, target: Target, star: Star, repeat: Repeat, bell: Bell,
  'user-cog': UserCog, 'line-chart': LineChart, 'credit-card': CreditCard, megaphone: Megaphone, 'file-text': FileText, 'user-plus': UserPlus,
  'message-circle': MessageCircle, hand: Hand, 'calendar-plus': CalendarPlus, 'calendar-clock': CalendarClock, 'calendar-x': CalendarX,
  'heart-pulse': HeartPulse, reply: Reply, 'alarm-clock': AlarmClock, 'file-bar-chart': FileBarChart, 'alert-triangle': AlertTriangle,
  'skip-forward': SkipForward, send: Send, 'user-round': UserRound, 'clipboard-list': ClipboardList, receipt: Receipt, 'calendar-check': CalendarCheck, 'user-check': UserCheck,
};
export const icon = (name: string): LucideIcon => ICONS[name] || Activity;
