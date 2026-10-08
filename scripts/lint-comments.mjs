import { Parser } from 'yaml';

export function cssComments(content) {
  const comments = [];
  let position = 0;
  while (position < content.length) {
    const character = content[position];
    if (character === '\\') {
      position += 2;
    } else if (character === '"' || character === "'") {
      position++;
      while (position < content.length && content[position] !== character) {
        position += content[position] === '\\' ? 2 : 1;
      }
      position++;
    } else if (content.startsWith('/*', position)) {
      const end = content.indexOf('*/', position + 2);
      const next = end === -1 ? content.length : end + 2;
      comments.push(content.slice(position, next));
      position = next;
    } else {
      position++;
    }
  }
  return comments;
}

export function htmlComments(content) {
  const comments = [];
  let position = 0;
  let tag = null;
  const lower = content.toLowerCase();
  while (position < content.length) {
    const character = content[position];
    if (!tag && content.startsWith('<!--', position)) {
      const end = content.indexOf('-->', position + 4);
      const next = end === -1 ? content.length : end + 3;
      comments.push(content.slice(position, next));
      position = next;
    } else if (tag && (character === '"' || character === "'")) {
      position = content.indexOf(character, position + 1);
      position = position === -1 ? content.length : position + 1;
    } else if (tag && character === '>') {
      position++;
      if (!tag.closing && ['script', 'style'].includes(tag.name)) {
        const closingTag = new RegExp(`</${tag.name}(?=[\\t\\n\\f\\r />])`, 'g');
        closingTag.lastIndex = position;
        position = closingTag.exec(lower)?.index ?? content.length;
      }
      tag = null;
    } else {
      const match = !tag && character === '<' && content.slice(position).match(/^<(\/?)([\w:-]+)/);
      if (match) {
        tag = { closing: Boolean(match[1]), name: match[2].toLowerCase() };
      }
      position++;
    }
  }
  return comments;
}

export function markdownComments(content) {
  const visible = [];
  let fence = null;
  for (const line of content.split('\n')) {
    const match = line.replace(/^ {0,3}(?:>\s*)+/, '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        match &&
        match[1][0] === fence.marker &&
        match[1].length >= fence.length &&
        match[2].trim() === ''
      ) {
        fence = null;
      }
    } else if (match) {
      fence = { marker: match[1][0], length: match[1].length };
    } else {
      visible.push(line);
    }
  }
  return htmlComments(visible.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, ''));
}

export function yamlComments(content) {
  const comments = [];
  const pending = [...new Parser().parse(content)];
  while (pending.length > 0) {
    const token = pending.pop();
    if (!token || typeof token !== 'object') {
      continue;
    }
    if (token.type === 'comment') {
      comments.push(token.source);
    }
    for (const value of Object.values(token)) {
      if (value && typeof value === 'object') {
        pending.push(value);
      }
    }
  }
  return comments;
}
