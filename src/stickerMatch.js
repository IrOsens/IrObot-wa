import sharp from 'sharp';

const COARSE_ANGLES = Array.from({ length: 12 }, (_, index) => index * 30);
const COARSE_SIZES = [0.07, 0.09, 0.11, 0.14, 0.18, 0.22, 0.26, 0.3, 0.35, 0.4, 0.46, 0.53, 0.6, 0.68, 0.78, 0.9, 1.05, 1.2];
const MAX_FRAMES = 12;
const MAX_ACCEPTED_ERROR = 2400;

export async function matchSticker(basePath, decoded, occupied = [], onFrame = null) {
  const sourceMeta = await sharp(basePath).metadata();
  const frameIndices = sampledFrames(decoded.frames.length);
  const frames = await Promise.all(frameIndices.map(async (index) => ({
    index,
    png: await sharp(decoded.frames[index].data, {
      raw: { width: decoded.width, height: decoded.height, channels: 4 }
    }).png().toBuffer()
  })));
  const coarseBase = await readBase(basePath, 192);
  const coarseCandidates = [];

  for (const frame of frames) {
    const frameCandidates = [];
    for (const fraction of COARSE_SIZES) {
      let sizeBest = null;
      for (const angle of COARSE_ANGLES) {
        const canvasWidth = Math.max(4, Math.round(coarseBase.width * fraction));
        const canvasHeight = Math.max(4, Math.round(canvasWidth * decoded.height / decoded.width));
        const template = await makeTemplate(frame.png, canvasWidth, canvasHeight, angle);
        if (!template) continue;
        const candidate = scan(coarseBase, template, null, 3, occupied, sourceMeta, sizeBest?.score ?? Infinity);
        if (candidate && (!sizeBest || candidate.score < sizeBest.score)) sizeBest = { ...candidate, frameIndex: frame.index };
      }
      if (sizeBest) frameCandidates.push(sizeBest);
    }
    coarseCandidates.push(...diverseCandidates(frameCandidates, 5));
    await onFrame?.(frames.findIndex((item) => item.index === frame.index) + 1, frames.length);
  }

  const middleBase = await readBase(basePath, 384);
  let middleBest = null;
  for (const candidate of coarseCandidates.sort(compareMatchCandidates).slice(0, 18)) {
    const frame = frames.find((item) => item.index === candidate.frameIndex);
    const refined = await refine({
      base: middleBase,
      previous: candidate,
      frame,
      sourceMeta,
      occupied,
      angleDeltas: [-15, -10, -5, 0, 5, 10, 15],
      scaleFactors: [0.8, 0.9, 1, 1.1, 1.2],
      radius: 18,
      positionStep: 2
    });
    if (refined && (!middleBest || compareMatchCandidates(refined, middleBest) < 0)) middleBest = refined;
  }
  if (!middleBest) return null;

  const finalBase = await readBase(basePath, 2048);
  const frame = frames.find((item) => item.index === middleBest.frameIndex);
  const final = await refine({
    base: finalBase,
    previous: middleBest,
    frame,
    sourceMeta,
    occupied,
    angleDeltas: [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5],
    scaleFactors: [0.94, 0.97, 1, 1.03, 1.06],
    radius: Math.max(6, Math.ceil(Math.max(finalBase.width, finalBase.height) * 0.008)),
    positionStep: 1
  });
  if (!final) return null;
  const polished = await polish(finalBase, final, frame, decoded, occupied, sourceMeta);
  const chosen = polished && polished.score < final.score ? polished : final;
  if (chosen.score > MAX_ACCEPTED_ERROR) return null;
  const chosenTemplate = await makeTemplate(frame.png, chosen.canvasWidth, chosen.canvasHeight, chosen.angle);
  if (chosenTemplate?.boundary.length >= 8 && boundarySupport(finalBase, chosenTemplate, chosen.visibleLeft, chosen.visibleTop) < 0.18) return null;

  const ratio = sourceMeta.width / finalBase.width;
  const transform = {
    left: Math.round(chosen.fullLeft * ratio),
    top: Math.round(chosen.fullTop * ratio),
    width: Math.max(1, Math.round(chosen.canvasWidth * ratio)),
    height: Math.max(1, Math.round(chosen.canvasHeight * ratio)),
    angle: chosen.angle,
    displayWidth: Math.round(chosen.displayWidth * ratio),
    displayHeight: Math.round(chosen.displayHeight * ratio),
    visibleLeft: Math.round(chosen.visibleLeft * ratio),
    visibleTop: Math.round(chosen.visibleTop * ratio),
    visibleWidth: Math.round(chosen.visibleWidth * ratio),
    visibleHeight: Math.round(chosen.visibleHeight * ratio),
    matchedFrameIndex: chosen.frameIndex,
    score: chosen.score
  };
  return transform;
}

async function polish(base, previous, frame, decoded, occupied, sourceMeta) {
  let best = previous;
  for (let angleDelta = -4; angleDelta <= 4; angleDelta++) {
    const angle = (previous.angle + angleDelta + 360) % 360;
    for (let widthDelta = -12; widthDelta <= 12; widthDelta++) {
      const canvasWidth = Math.max(4, previous.canvasWidth + widthDelta);
      const canvasHeight = Math.max(4, Math.round(canvasWidth * decoded.height / decoded.width));
      const template = await makeTemplate(frame.png, canvasWidth, canvasHeight, angle);
      if (!template) continue;
      const candidate = scan(base, template, {
        centerX: previous.fullLeft + template.bounds.left,
        centerY: previous.fullTop + template.bounds.top,
        radius: 7
      }, 1, occupied, sourceMeta, best.score);
      if (candidate && candidate.score < best.score) best = { ...candidate, frameIndex: frame.index };
    }
  }
  return best;
}

function diverseCandidates(candidates, limit) {
  const selected = [];
  for (const candidate of candidates.sort(compareMatchCandidates)) {
    if (selected.some((item) => Math.abs(Math.log(item.canvasWidth / candidate.canvasWidth)) < 0.2)) continue;
    selected.push(candidate);
    if (selected.length >= limit) break;
  }
  return selected;
}

function compareMatchCandidates(a, b) {
  // A uniformly coloured inner patch can match a cropped version of the
  // sticker just as well as the full reference. Prefer the larger match when
  // their pixel errors are close.
  const rank = (item) => item.score - 30 * Math.log(Math.max(1, item.visibleWidth * item.visibleHeight));
  return rank(a) - rank(b);
}

function sampledFrames(count) {
  if (count <= MAX_FRAMES) return Array.from({ length: count }, (_, index) => index);
  return [...new Set(Array.from({ length: MAX_FRAMES }, (_, index) => Math.round(index * (count - 1) / (MAX_FRAMES - 1))))];
}

async function readBase(basePath, maxDimension) {
  const { data, info } = await sharp(basePath)
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

async function makeTemplate(framePng, canvasWidth, canvasHeight, angle) {
  const { data, info } = await sharp(framePng)
    .resize(canvasWidth, canvasHeight, { fit: 'fill' })
    .rotate(angle, { background: '#00000000' })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const bounds = alphaBounds(data, info.width, info.height, info.channels);
  if (!bounds) return null;
  const samples = opaqueSamples(data, info.width, info.channels, bounds, 210);
  if (samples.length < 8) samples.push(...opaqueSamples(data, info.width, info.channels, bounds, 100));
  if (samples.length < 8) return null;
  const edges = interiorEdges(data, info.width, info.channels, bounds);
  const boundary = boundarySamples(data, info.width, info.height, info.channels, bounds);
  return { data, canvasWidth, canvasHeight, angle, width: info.width, height: info.height, bounds, samples, edges, boundary };
}

function boundarySamples(data, width, height, channels, bounds) {
  const samples = [];
  const opaque = (x, y) => data[(y * width + x) * channels + 3] >= 180;
  const count = 24;
  for (let index = 0; index < count; index++) {
    const y = bounds.top + Math.round(index * (bounds.height - 1) / (count - 1));
    let left = bounds.left;
    while (left < bounds.left + bounds.width && !opaque(left, y)) left++;
    let right = bounds.left + bounds.width - 1;
    while (right >= left && !opaque(right, y)) right--;
    if (left <= right) {
      samples.push({ x: left - bounds.left, y: y - bounds.top, dx: -1, dy: 0 });
      samples.push({ x: right - bounds.left, y: y - bounds.top, dx: 1, dy: 0 });
    }
    const x = bounds.left + Math.round(index * (bounds.width - 1) / (count - 1));
    let top = bounds.top;
    while (top < bounds.top + bounds.height && !opaque(x, top)) top++;
    let bottom = bounds.top + bounds.height - 1;
    while (bottom >= top && !opaque(x, bottom)) bottom--;
    if (top <= bottom) {
      samples.push({ x: x - bounds.left, y: top - bounds.top, dx: 0, dy: -1 });
      samples.push({ x: x - bounds.left, y: bottom - bounds.top, dx: 0, dy: 1 });
    }
  }
  return samples;
}

function alphaBounds(data, width, height, channels) {
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * channels + 3] < 16) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < left ? null : { left, top, width: right - left + 1, height: bottom - top + 1 };
}

function opaqueSamples(data, width, channels, bounds, minAlpha) {
  const samples = [];
  const stepX = Math.max(1, Math.floor(bounds.width / 11));
  const stepY = Math.max(1, Math.floor(bounds.height / 11));
  for (let y = bounds.top; y < bounds.top + bounds.height; y += stepY) {
    for (let x = bounds.left; x < bounds.left + bounds.width; x += stepX) {
      const offset = (y * width + x) * channels;
      if (data[offset + 3] < minAlpha) continue;
      samples.push({ x: x - bounds.left, y: y - bounds.top, r: data[offset], g: data[offset + 1], b: data[offset + 2] });
    }
  }
  return samples;
}

function interiorEdges(data, width, channels, bounds) {
  const edges = [];
  const stepX = Math.max(1, Math.floor(bounds.width / 12));
  const stepY = Math.max(1, Math.floor(bounds.height / 12));
  for (let y = bounds.top; y < bounds.top + bounds.height - 1; y += stepY) {
    for (let x = bounds.left; x < bounds.left + bounds.width - 1; x += stepX) {
      const at = (y * width + x) * channels;
      const right = at + channels;
      const down = at + width * channels;
      if (data[at + 3] < 210 || data[right + 3] < 210 || data[down + 3] < 210) continue;
      const dx = [0, 1, 2].map((channel) => data[right + channel] - data[at + channel]);
      const dy = [0, 1, 2].map((channel) => data[down + channel] - data[at + channel]);
      const strength = [...dx, ...dy].reduce((sum, value) => sum + value * value, 0);
      if (strength < 900) continue;
      edges.push({ x: x - bounds.left, y: y - bounds.top, dx, dy });
    }
  }
  return edges;
}

async function refine({ base, previous, frame, sourceMeta, occupied, angleDeltas, scaleFactors, radius, positionStep }) {
  const ratio = base.width / previous.baseWidth;
  const predictedLeft = previous.fullLeft * ratio;
  const predictedTop = previous.fullTop * ratio;
  let best = null;
  for (const delta of angleDeltas) {
    const angle = (previous.angle + delta + 360) % 360;
    for (const factor of scaleFactors) {
      const canvasWidth = Math.max(4, Math.round(previous.canvasWidth * ratio * factor));
      const canvasHeight = Math.max(4, Math.round(previous.canvasHeight * ratio * factor));
      const template = await makeTemplate(frame.png, canvasWidth, canvasHeight, angle);
      if (!template) continue;
      const centerX = predictedLeft + template.bounds.left;
      const centerY = predictedTop + template.bounds.top;
      const candidate = scan(base, template, { centerX, centerY, radius }, positionStep, occupied, sourceMeta, Infinity);
      if (candidate && (!best || compareMatchCandidates(candidate, best) < 0)) best = { ...candidate, frameIndex: frame.index };
    }
  }
  return best;
}

function scan(base, template, area, step, occupied, sourceMeta, maximum) {
  const { bounds, samples } = template;
  const xStart = Math.max(0, Math.ceil(area ? area.centerX - area.radius : 0));
  const yStart = Math.max(0, Math.ceil(area ? area.centerY - area.radius : 0));
  const xEnd = Math.min(base.width - bounds.width, Math.floor(area ? area.centerX + area.radius : base.width - bounds.width));
  const yEnd = Math.min(base.height - bounds.height, Math.floor(area ? area.centerY + area.radius : base.height - bounds.height));
  if (xEnd < xStart || yEnd < yStart) return null;
  const scale = base.width / sourceMeta.width;
  const occupiedRects = occupied.map((item) => ({
    left: item.visibleLeft * scale,
    top: item.visibleTop * scale,
    width: item.visibleWidth * scale,
    height: item.visibleHeight * scale
  }));
  let best = null;
  for (let y = yStart; y <= yEnd; y += step) {
    for (let x = xStart; x <= xEnd; x += step) {
      if (overlaps(x, y, bounds.width, bounds.height, occupiedRects)) continue;
      const score = sampleError(base, template, x, y, Math.min(maximum, best?.score ?? Infinity));
      if (score >= Math.min(maximum, best?.score ?? Infinity)) continue;
      best = {
        score, fullLeft: x - bounds.left, fullTop: y - bounds.top,
        visibleLeft: x, visibleTop: y, visibleWidth: bounds.width, visibleHeight: bounds.height,
        canvasWidth: template.canvasWidth, canvasHeight: template.canvasHeight,
        displayWidth: template.width, displayHeight: template.height,
        angle: template.angle, baseWidth: base.width
      };
    }
  }
  return best;
}

function sampleError(base, template, x, y, cutoff) {
  const { samples, edges, boundary } = template;
  let error = 0;
  const weight = 0.2;
  const boundaryWeight = 0.5;
  const denominator = samples.length + edges.length * weight + boundary.length * boundaryWeight;
  for (const sample of samples) {
    const offset = ((y + sample.y) * base.width + x + sample.x) * base.channels;
    const red = base.data[offset] - sample.r;
    const green = base.data[offset + 1] - sample.g;
    const blue = base.data[offset + 2] - sample.b;
    error += (red * red + green * green + blue * blue) / 3;
    if (error / denominator >= cutoff) return Infinity;
  }
  for (const edge of edges) {
    const offset = ((y + edge.y) * base.width + x + edge.x) * base.channels;
    const right = offset + base.channels;
    const down = offset + base.width * base.channels;
    for (let channel = 0; channel < 3; channel++) {
      const dx = base.data[right + channel] - base.data[offset + channel] - edge.dx[channel];
      const dy = base.data[down + channel] - base.data[offset + channel] - edge.dy[channel];
      error += weight * (dx * dx + dy * dy) / 6;
    }
    if (error / denominator >= cutoff) return Infinity;
  }
  for (const point of boundary) {
    const insideX = x + point.x;
    const insideY = y + point.y;
    const outsideX = insideX + point.dx;
    const outsideY = insideY + point.dy;
    if (outsideX < 0 || outsideY < 0 || outsideX >= base.width || outsideY >= base.height) continue;
    const inside = (insideY * base.width + insideX) * base.channels;
    const outside = (outsideY * base.width + outsideX) * base.channels;
    const contrast = Math.sqrt(([0, 1, 2].reduce((sum, channel) => {
      const difference = base.data[inside + channel] - base.data[outside + channel];
      return sum + difference * difference;
    }, 0)) / 3);
    error += boundaryWeight * Math.max(0, 40 - contrast) ** 2;
    if (error / denominator >= cutoff) return Infinity;
  }
  return error / denominator;
}

function boundarySupport(base, template, x, y) {
  let supported = 0;
  let measured = 0;
  for (const point of template.boundary) {
    const insideX = x + point.x;
    const insideY = y + point.y;
    const outsideX = insideX + point.dx;
    const outsideY = insideY + point.dy;
    if (outsideX < 0 || outsideY < 0 || outsideX >= base.width || outsideY >= base.height) continue;
    const inside = (insideY * base.width + insideX) * base.channels;
    const outside = (outsideY * base.width + outsideX) * base.channels;
    const contrast = Math.sqrt(([0, 1, 2].reduce((sum, channel) => {
      const difference = base.data[inside + channel] - base.data[outside + channel];
      return sum + difference * difference;
    }, 0)) / 3);
    measured++;
    if (contrast >= 25) supported++;
  }
  return measured ? supported / measured : 1;
}

function overlaps(x, y, width, height, occupied) {
  return occupied.some((box) => {
    const overlapWidth = Math.max(0, Math.min(x + width, box.left + box.width) - Math.max(x, box.left));
    const overlapHeight = Math.max(0, Math.min(y + height, box.top + box.height) - Math.max(y, box.top));
    return overlapWidth * overlapHeight > Math.min(width * height, box.width * box.height) * 0.35;
  });
}
