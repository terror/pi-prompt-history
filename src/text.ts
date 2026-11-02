const unsafeCharacters = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]/gu;

export function sanitizeText(text: string) {
  if (text.search(unsafeCharacters) === -1) {
    return { text, truncated: false };
  }

  let sanitized = '';

  let truncated = false;

  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);

    if (character !== '\x1b') {
      sanitized += character;

      continue;
    }

    const introducer = text.charAt(++index);

    if (!introducer) {
      truncated = true;

      break;
    }

    if (introducer === '[') {
      index++;

      while (index < text.length && !/[@-~]/.test(text.charAt(index))) {
        index++;
      }
    } else if (']PX^_'.includes(introducer)) {
      index++;

      while (
        index < text.length &&
        text.charAt(index) !== '\x07' &&
        !(text.charAt(index) === '\x1b' && text.charAt(index + 1) === '\\')
      ) {
        index++;
      }

      if (text.charAt(index) === '\x1b') {
        index++;
      }
    } else {
      while (index < text.length && /[ -/]/.test(text.charAt(index))) {
        index++;
      }
    }

    if (index >= text.length) {
      truncated = true;
    }
  }

  return {
    text: sanitized.replace(unsafeCharacters, ''),
    truncated,
  };
}
