import {Easing, interpolate} from 'remotion';

// Times are recording seconds, excluding the 2.4-second logo opening.
// x is the phone's horizontal center; focusY is a point in the 430×860 recording.
// screenY is where that point lands in the 1920×1080 film.
export const cameraKeys = [
  {s:0, zoom:1, x:1390, focusY:430, screenY:540},
  {s:1.4, zoom:1.08, x:1370, focusY:430, screenY:540},
  {s:6.7, zoom:1.08, x:1370, focusY:430, screenY:540},
  {s:8.6, zoom:1.40, x:1400, focusY:540, screenY:600},
  {s:10.2, zoom:1.40, x:1400, focusY:540, screenY:600},
  {s:11.7, zoom:1.02, x:1390, focusY:430, screenY:540},
  {s:15.2, zoom:1.02, x:1390, focusY:430, screenY:540},
  {s:16.3, zoom:1.35, x:1360, focusY:570, screenY:615},
  {s:18.6, zoom:1.43, x:1360, focusY:385, screenY:550},
  {s:20.8, zoom:1.43, x:1360, focusY:385, screenY:550},
  {s:21.8, zoom:1.07, x:1390, focusY:430, screenY:540},
  {s:23.8, zoom:1.45, x:1360, focusY:380, screenY:550},
  {s:26.5, zoom:1.45, x:1360, focusY:380, screenY:550},
  {s:28.0, zoom:1.04, x:1390, focusY:430, screenY:540},
  {s:29.6, zoom:1.43, x:1370, focusY:635, screenY:650},
  {s:33.4, zoom:1.43, x:1370, focusY:635, screenY:650},
  {s:34.7, zoom:1.04, x:1390, focusY:430, screenY:540},
  {s:39.5, zoom:1.04, x:1390, focusY:430, screenY:540},
  {s:41.5, zoom:1.18, x:1390, focusY:570, screenY:650},
  {s:42.6, zoom:1.18, x:1390, focusY:570, screenY:650},
];

export function cameraAt(seconds:number, strength:number) {
  const amount=Math.min(1.3, Math.max(0, strength));
  const at=(key:'zoom'|'x'|'focusY'|'screenY')=>interpolate(seconds,
    cameraKeys.map(k=>k.s),cameraKeys.map(k=>k[key]),
    {extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.inOut(Easing.cubic)});
  return {scale:1+(at('zoom')-1)*amount, x:1390+(at('x')-1390)*amount,
    focusY:430+(at('focusY')-430)*amount, screenY:540+(at('screenY')-540)*amount};
}
