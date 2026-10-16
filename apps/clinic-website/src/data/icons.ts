// Curated Lucide icon set — only icons used on the site are bundled.
// Raw SVG strings are read at build time and inlined by <Icon />; no icon runtime ships to the client.

import i_bone from 'lucide-static/icons/bone.svg?raw';
import i_activity from 'lucide-static/icons/activity.svg?raw';
import i_footprints from 'lucide-static/icons/footprints.svg?raw';
import i_hand from 'lucide-static/icons/hand.svg?raw';
import i_zap from 'lucide-static/icons/zap.svg?raw';
import i_dumbbell from 'lucide-static/icons/dumbbell.svg?raw';
import i_person_standing from 'lucide-static/icons/person-standing.svg?raw';
import i_flame from 'lucide-static/icons/flame.svg?raw';
import i_stethoscope from 'lucide-static/icons/stethoscope.svg?raw';
import i_heart_pulse from 'lucide-static/icons/heart-pulse.svg?raw';
import i_shield_check from 'lucide-static/icons/shield-check.svg?raw';
import i_layers from 'lucide-static/icons/layers.svg?raw';
import i_message_circle from 'lucide-static/icons/message-circle.svg?raw';
import i_phone from 'lucide-static/icons/phone.svg?raw';
import i_map_pin from 'lucide-static/icons/map-pin.svg?raw';
import i_arrow_up_right from 'lucide-static/icons/arrow-up-right.svg?raw';
import i_arrow_right from 'lucide-static/icons/arrow-right.svg?raw';
import i_menu from 'lucide-static/icons/menu.svg?raw';
import i_x from 'lucide-static/icons/x.svg?raw';
import i_plus from 'lucide-static/icons/plus.svg?raw';
import i_star from 'lucide-static/icons/star.svg?raw';
import i_clock from 'lucide-static/icons/clock.svg?raw';
import i_chevron_left from 'lucide-static/icons/chevron-left.svg?raw';
import i_chevron_right from 'lucide-static/icons/chevron-right.svg?raw';
import i_navigation from 'lucide-static/icons/navigation.svg?raw';
import i_camera from 'lucide-static/icons/camera.svg?raw';
import i_building_2 from 'lucide-static/icons/building-2.svg?raw';
import i_armchair from 'lucide-static/icons/armchair.svg?raw';
import i_bed_single from 'lucide-static/icons/bed-single.svg?raw';
import i_signpost from 'lucide-static/icons/signpost.svg?raw';
import i_accessibility from 'lucide-static/icons/accessibility.svg?raw';
import i_bandage from 'lucide-static/icons/bandage.svg?raw';
import i_scale from 'lucide-static/icons/scale.svg?raw';
import i_thermometer_sun from 'lucide-static/icons/thermometer-sun.svg?raw';
import i_pause from 'lucide-static/icons/pause.svg?raw';
import i_play from 'lucide-static/icons/play.svg?raw';
import i_map from 'lucide-static/icons/map.svg?raw';
import i_user_round from 'lucide-static/icons/user-round.svg?raw';

export const icons = {
  'bone': i_bone,
  'activity': i_activity,
  'footprints': i_footprints,
  'hand': i_hand,
  'zap': i_zap,
  'dumbbell': i_dumbbell,
  'person-standing': i_person_standing,
  'flame': i_flame,
  'stethoscope': i_stethoscope,
  'heart-pulse': i_heart_pulse,
  'shield-check': i_shield_check,
  'layers': i_layers,
  'message-circle': i_message_circle,
  'phone': i_phone,
  'map-pin': i_map_pin,
  'arrow-up-right': i_arrow_up_right,
  'arrow-right': i_arrow_right,
  'menu': i_menu,
  'x': i_x,
  'plus': i_plus,
  'star': i_star,
  'clock': i_clock,
  'chevron-left': i_chevron_left,
  'chevron-right': i_chevron_right,
  'navigation': i_navigation,
  'camera': i_camera,
  'building-2': i_building_2,
  'armchair': i_armchair,
  'bed-single': i_bed_single,
  'signpost': i_signpost,
  'accessibility': i_accessibility,
  'bandage': i_bandage,
  'scale': i_scale,
  'thermometer-sun': i_thermometer_sun,
  'pause': i_pause,
  'play': i_play,
  'map': i_map,
  'user-round': i_user_round,
} as const;

export type IconName = keyof typeof icons;
