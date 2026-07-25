import sharp from 'sharp';
import { mkdirSync } from 'fs';

const CENTER = 256;

function polar(radius, deg) {
  const rad = (deg - 90) * (Math.PI / 180);
  return [CENTER + radius * Math.cos(rad), CENTER + radius * Math.sin(rad)];
}

function irisBlades(innerR, outerR, count, skewDeg, fill) {
  const step = 360 / count;
  const bladeWidth = step * 0.6;
  let out = '';
  for (let i = 0; i < count; i++) {
    const start = step * i;
    const [x1, y1] = polar(innerR, start);
    const [x2, y2] = polar(outerR, start + skewDeg);
    const [x3, y3] = polar(outerR, start + skewDeg + bladeWidth);
    const [x4, y4] = polar(innerR, start + bladeWidth);
    out += `<polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3} ${x4},${y4}" fill="${fill}" />`;
  }
  return out;
}

function trianglePoints(r) {
  return [0, 120, 240].map((deg) => polar(r, deg).join(',')).join(' ');
}

function reactorSvg({ bgFill, bgFull }) {
  return `
<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="core" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" />
      <stop offset="25%" stop-color="#e2fbff" />
      <stop offset="60%" stop-color="#4cd9ff" />
      <stop offset="100%" stop-color="#0a3040" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="bloom" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#bdf3ff" stop-opacity="0.9" />
      <stop offset="100%" stop-color="#bdf3ff" stop-opacity="0" />
    </radialGradient>
    <filter id="glow" x="-100%" y="-100%" width="300%" height="300%">
      <feGaussianBlur stdDeviation="6" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <filter id="bloomBlur" x="-200%" y="-200%" width="500%" height="500%">
      <feGaussianBlur stdDeviation="18" />
    </filter>
  </defs>

  ${bgFull ? `<rect x="0" y="0" width="512" height="512" fill="${bgFill}" />` : `<circle cx="256" cy="256" r="256" fill="${bgFill}" />`}

  <circle cx="256" cy="256" r="220" fill="none" stroke="#d9a75c" stroke-width="4" opacity="0.55" />
  <circle cx="256" cy="256" r="196" fill="none" stroke="#d9a75c" stroke-width="10" opacity="0.85" />

  <circle cx="256" cy="256" r="150" fill="url(#bloom)" filter="url(#bloomBlur)" style="mix-blend-mode:screen" />

  ${irisBlades(92, 140, 18, 22, '#d9a75c')}

  <circle cx="256" cy="256" r="76" fill="url(#core)" filter="url(#glow)" style="mix-blend-mode:screen" />

  <polygon points="${trianglePoints(52)}" fill="none" stroke="#eafcff" stroke-width="5" stroke-linejoin="round" filter="url(#glow)" />
</svg>`;
}

async function main() {
  mkdirSync('public', { recursive: true });

  const standard = reactorSvg({ bgFill: '#08060a', bgFull: false });
  const maskable = reactorSvg({ bgFill: '#08060a', bgFull: true });

  await sharp(Buffer.from(standard)).resize(512, 512).png().toFile('public/icon-512.png');
  await sharp(Buffer.from(standard)).resize(192, 192).png().toFile('public/icon-192.png');
  await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile('public/icon-maskable-512.png');
  await sharp(Buffer.from(standard)).resize(180, 180).flatten({ background: '#08060a' }).png().toFile('public/apple-touch-icon.png');

  console.log('Icons generated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
