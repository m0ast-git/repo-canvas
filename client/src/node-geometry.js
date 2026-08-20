export const ENTITY_MIN_WIDTH = 268;
export const ENTITY_MAX_WIDTH = 440;
export const ENTITY_BASE_HEIGHT = 126;
export const ENTITY_TITLE_LINE_HEIGHT = 19;
export const GROUP_HEADER_MIN_HEIGHT = 76;
export const GROUP_HEADER_MAX_WIDTH = 420;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function visibleEntityLabel(entity = {}) {
  return String(entity.ownerLabel || entity.label || "Элемент").trim();
}

export function visibleEntityPurpose(entity = {}) {
  return String(entity.ownerPurpose || entity.purpose || entity.path || "").trim();
}

export function estimateTextWidth(text, fontSize = 15) {
  let units = 0;
  for (const character of String(text || "")) {
    if (/\s/u.test(character)) units += .34;
    else if (/[MWШЩЖФЮ@%]/u.test(character)) units += .86;
    else if (/[A-ZА-ЯЁ0-9]/u.test(character)) units += .68;
    else if (/[.,:;!|()\[\]{}'"`-]/u.test(character)) units += .35;
    else units += .56;
  }
  return units * fontSize;
}

export function wrappedLineCount(text, availableWidth, fontSize = 15) {
  const width = Math.max(32, availableWidth);
  const words = String(text || "").trim().split(/\s+/u).filter(Boolean);
  if (!words.length) return 1;
  let lines = 1; let current = 0;
  for (const word of words) {
    const wordWidth = estimateTextWidth(word, fontSize);
    if (wordWidth > width) {
      const chunks = Math.ceil(wordWidth / width);
      if (current > 0) { lines += 1; current = 0; }
      lines += chunks - 1;
      current = wordWidth - (chunks - 1) * width;
      continue;
    }
    const gap = current > 0 ? estimateTextWidth(" ", fontSize) : 0;
    if (current > 0 && current + gap + wordWidth > width) { lines += 1; current = wordWidth; }
    else current += gap + wordWidth;
  }
  return lines;
}

export function entityCardSize(entity = {}) {
  const title = visibleEntityLabel(entity);
  const naturalWidth = estimateTextWidth(title, 15) + 58;
  const width = Math.ceil(clamp(naturalWidth, ENTITY_MIN_WIDTH, ENTITY_MAX_WIDTH));
  const titleLines = wrappedLineCount(title, width - 44, 15);
  const height = ENTITY_BASE_HEIGHT + Math.max(0, titleLines - 1) * ENTITY_TITLE_LINE_HEIGHT;
  return { width, height, titleLines };
}

export function groupHeaderSize(entity = {}, widthHint = 360) {
  const width = Math.ceil(clamp(widthHint, 280, GROUP_HEADER_MAX_WIDTH));
  const titleLines = wrappedLineCount(visibleEntityLabel(entity), width - 64, 14);
  const purposeLines = Math.min(2, wrappedLineCount(visibleEntityPurpose(entity), width - 64, 9));
  const height = GROUP_HEADER_MIN_HEIGHT + Math.max(0, titleLines - 1) * 17 + Math.max(0, purposeLines - 1) * 13;
  return { width, height, titleLines, purposeLines };
}
