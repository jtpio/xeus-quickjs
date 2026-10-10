/***************************************************************************
* Copyright (c) 2026, Jeremy Tuloup                                        *
*                                                                          *
* Distributed under the terms of the BSD 3-Clause License.                 *
*                                                                          *
* The full license is in the file LICENSE, distributed with this software. *
****************************************************************************/

// The JavaScript side of xeus-quickjs.
//
// This script evaluates to a function, called once by the interpreter with
// the native functions of the kernel, the acorn parser and the factory of
// the widgets (widgets.js). It installs the
// globals available in notebooks (console, display, timers...) and returns
// the object the interpreter calls to handle the requests of the Jupyter
// protocol.
(function (native, acorn, widgetsFactory) {
'use strict';

const global = globalThis;
const indirectEval = global.eval;
const RUNTIME_FILES = new Set(['xeus-quickjs:runtime', 'xeus-quickjs:widgets', 'xeus-quickjs:acorn']);

/*************
 * Utilities *
 *************/

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function defineGlobal(name, value) {
  Object.defineProperty(global, name, { value, writable: true, configurable: true, enumerable: false });
}

const ANSI = {
  bold: [1, 22], dim: [2, 22], underline: [4, 24],
  red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39],
  magenta: [35, 39], cyan: [36, 39], gray: [90, 39]
};

function color(name, text) {
  const [open, close] = ANSI[name];
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function safe(f, fallback) {
  try {
    return f();
  } catch (e) {
    return fallback;
  }
}

// The Jupyter protocol counts cursor positions in unicode code points, while
// JavaScript strings are indexed by UTF-16 code units.
function toUtf16Index(text, cursor) {
  let index = 0;
  for (let count = 0; count < cursor && index < text.length; count++) {
    const code = text.charCodeAt(index);
    index += code >= 0xd800 && code <= 0xdbff && index + 1 < text.length ? 2 : 1;
  }
  return index;
}

function toCodePointIndex(text, index) {
  let count = 0;
  for (let i = 0; i < index && i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      i++;
    }
    count++;
  }
  return count;
}

const IDENTIFIER = String.raw`[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*`;
const IDENTIFIER_RE = new RegExp(`^${IDENTIFIER}$`, 'u');

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**********
 * Base64 *
 **********/

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes) {
  const chunks = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    chunks.push(BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63]);
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i] << 16;
    chunks.push(BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + '==');
  } else if (remaining === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    chunks.push(BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + '=');
  }
  return chunks.join('');
}

function base64ToBytes(text) {
  const clean = String(text).replace(/[\t\n\f\r ]/g, '').replace(/=+$/, '');
  if (clean.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(clean)) {
    throw new DOMException('The string to be decoded is not correctly encoded.', 'InvalidCharacterError');
  }
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let j = 0;
  for (const char of clean) {
    buffer = (buffer << 6) | BASE64.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[j++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes;
}

function toBytes(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

/***********
 * inspect *
 ***********/

// Formats values like util.inspect in Node.js, which is what the console and
// the outputs of the cells use.

const STYLES = {
  number: 'yellow', bigint: 'yellow', boolean: 'yellow', undefined: 'gray',
  null: 'bold', string: 'green', symbol: 'green', date: 'magenta',
  regexp: 'red', special: 'cyan', module: 'underline'
};

const INSPECT_DEFAULTS = { depth: 2, colors: false, breakLength: 80, maxArrayLength: 100, maxStringLength: 10000 };

const customInspectSymbol = Symbol.for('nodejs.util.inspect.custom');

function inspect(value, options) {
  const ctx = Object.assign({}, INSPECT_DEFAULTS, options, { seen: [], indentation: 0 });
  if (ctx.depth === null) {
    ctx.depth = Infinity;
  }
  return formatValue(ctx, value, 0);
}

function stylize(ctx, text, style) {
  return ctx.colors && STYLES[style] ? color(STYLES[style], text) : text;
}

const STRING_ESCAPES = { '\n': '\\n', '\t': '\\t', '\r': '\\r', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\\': '\\\\' };

function quoteString(text) {
  let quote = "'";
  if (text.includes("'")) {
    if (!text.includes('"')) {
      quote = '"';
    } else if (!text.includes('`') && !text.includes('${')) {
      quote = '`';
    }
  }
  let result = '';
  for (const char of text) {
    if (char === quote) {
      result += '\\' + char;
    } else if (STRING_ESCAPES[char]) {
      result += STRING_ESCAPES[char];
    } else if (char < ' ' || char === '\x7f') {
      result += '\\x' + char.charCodeAt(0).toString(16).padStart(2, '0');
    } else {
      result += char;
    }
  }
  return quote + result + quote;
}

function formatPrimitive(ctx, value) {
  switch (typeof value) {
    case 'string': {
      let text = value;
      let trailer = '';
      if (text.length > ctx.maxStringLength) {
        trailer = `... ${text.length - ctx.maxStringLength} more characters`;
        text = text.slice(0, ctx.maxStringLength);
      }
      return stylize(ctx, quoteString(text), 'string') + trailer;
    }
    case 'number':
      return stylize(ctx, Object.is(value, -0) ? '-0' : String(value), 'number');
    case 'bigint':
      return stylize(ctx, `${value}n`, 'bigint');
    case 'boolean':
      return stylize(ctx, String(value), 'boolean');
    case 'undefined':
      return stylize(ctx, 'undefined', 'undefined');
    case 'symbol':
      return stylize(ctx, value.toString(), 'symbol');
  }
  return String(value);
}

function formatValue(ctx, value, level) {
  if (value === null) {
    return stylize(ctx, 'null', 'null');
  }
  if (typeof value !== 'object' && typeof value !== 'function') {
    return formatPrimitive(ctx, value);
  }
  const custom = safe(() => value[customInspectSymbol]);
  if (typeof custom === 'function') {
    const options = Object.assign({}, ctx, { depth: ctx.depth - level, stylize: (text, style) => stylize(ctx, text, style) });
    const result = custom.call(value, ctx.depth - level, options, inspect);
    if (result !== value) {
      return typeof result === 'string' ? result : formatValue(ctx, result, level);
    }
  }
  if (ctx.seen.includes(value)) {
    return stylize(ctx, '[Circular]', 'special');
  }
  return formatObject(ctx, value, level);
}

function getConstructorName(object) {
  let current = object;
  for (let i = 0; current !== null && i < 100; i++) {
    const descriptor = safe(() => Object.getOwnPropertyDescriptor(current, 'constructor'));
    if (descriptor && typeof descriptor.value === 'function' && descriptor.value.name !== '') {
      return descriptor.value.name;
    }
    current = safe(() => Object.getPrototypeOf(current), null);
  }
  return null;
}

function getPrefix(constructorName, tag, fallback, size = '') {
  if (constructorName === null) {
    return tag && tag !== fallback
      ? `[${fallback}${size}: null prototype] [${tag}] `
      : `[${fallback}${size}: null prototype] `;
  }
  if (tag && constructorName !== tag) {
    return `${constructorName}${size} [${tag}] `;
  }
  return `${constructorName}${size} `;
}

function isClass(fn) {
  const source = safe(() => Function.prototype.toString.call(fn), '');
  return /^class\b/.test(source);
}

function functionBase(fn, constructorName, tag) {
  if (isClass(fn)) {
    let base = `[class ${fn.name || '(anonymous)'}`;
    const superclass = safe(() => Object.getPrototypeOf(fn));
    if (typeof superclass === 'function' && superclass.name) {
      base += ` extends ${superclass.name}`;
    }
    return base + ']';
  }
  let type = 'Function';
  if (['AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction'].includes(constructorName)) {
    type = constructorName;
  }
  let base = `[${type}`;
  if (constructorName === null) {
    base += ' (null prototype)';
  }
  base += fn.name ? `: ${fn.name}` : ' (anonymous)';
  base += ']';
  if (constructorName !== type && constructorName !== 'Function' && constructorName !== null) {
    base += ` ${constructorName}`;
  }
  if (tag && constructorName !== tag) {
    base += ` [${tag}]`;
  }
  return base;
}

function formatErrorValue(ctx, error, level) {
  const name = safe(() => String(error.name), 'Error');
  const message = safe(() => String(error.message), '');
  const head = message ? `${name}: ${message}` : name;
  if (level > 0) {
    return `[${head}]`;
  }
  const frames = parseStack(safe(() => error.stack, ''));
  return [head, ...frames.map(frame => formatFrame(frame, ctx.colors))].join('\n');
}

function formatKey(ctx, key) {
  if (typeof key === 'symbol') {
    return `[${stylize(ctx, key.toString(), 'symbol')}]`;
  }
  if (IDENTIFIER_RE.test(key)) {
    return key;
  }
  return stylize(ctx, quoteString(key), 'string');
}

function formatNested(ctx, value, level) {
  ctx.indentation += 2;
  const result = formatValue(ctx, value, level + 1);
  ctx.indentation -= 2;
  return result;
}

function formatProperty(ctx, object, level, key) {
  const descriptor = safe(() => Object.getOwnPropertyDescriptor(object, key)) || { value: safe(() => object[key]) };
  let text;
  if (hasOwn(descriptor, 'value')) {
    text = formatNested(ctx, descriptor.value, level);
  } else if (descriptor.get) {
    text = stylize(ctx, descriptor.set ? '[Getter/Setter]' : '[Getter]', 'special');
  } else if (descriptor.set) {
    text = stylize(ctx, '[Setter]', 'special');
  } else {
    text = stylize(ctx, 'undefined', 'undefined');
  }
  return `${formatKey(ctx, key)}: ${text}`;
}

function formatArrayLike(ctx, value, level, length, getItem) {
  const output = [];
  const max = Math.min(ctx.maxArrayLength, length);
  let i = 0;
  while (i < length && output.length < max) {
    if (getItem === null && !hasOwn(value, i)) {
      let j = i;
      while (j < length && !hasOwn(value, j)) {
        j++;
      }
      const holes = j - i;
      output.push(stylize(ctx, `<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'));
      i = j;
      continue;
    }
    output.push(formatNested(ctx, getItem === null ? value[i] : getItem(i), level));
    i++;
  }
  if (i < length) {
    const remaining = length - i;
    output.push(`... ${remaining} more item${remaining > 1 ? 's' : ''}`);
  }
  return output;
}

const typedArrayPrototype = Object.getPrototypeOf(Int8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length').get;
const typedArrayTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag).get;
const mapSize = Object.getOwnPropertyDescriptor(Map.prototype, 'size').get;
const setSize = Object.getOwnPropertyDescriptor(Set.prototype, 'size').get;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;

const isTypedArray = value => typedArrayTag.call(value) !== undefined;
const isMap = value => safe(() => (mapSize.call(value), true), false);
const isSet = value => safe(() => (setSize.call(value), true), false);
const isArrayBuffer = value => safe(() => (arrayBufferByteLength.call(value), true), false);
const isDate = value => safe(() => (Date.prototype.getTime.call(value), true), false);
const isRegExp = value => safe(() => (Object.getOwnPropertyDescriptor(RegExp.prototype, 'source').get.call(value), true), false);
const isError = value => value instanceof Error || safe(() => Object.prototype.toString.call(value) === '[object Error]', false);
const isPromise = value => native.promiseState(value)[0] >= 0;
const isModuleNamespace = value => safe(() => value[Symbol.toStringTag] === 'Module' && Object.getPrototypeOf(value) === null, false);

function formatObject(ctx, value, level) {
  const constructorName = getConstructorName(value);
  let tag = safe(() => value[Symbol.toStringTag], '');
  if (typeof tag !== 'string' || tag === constructorName) {
    tag = '';
  }

  let keys = safe(() => Object.keys(value), []);
  const symbols = safe(() => Object.getOwnPropertySymbols(value), [])
    .filter(symbol => safe(() => Object.prototype.propertyIsEnumerable.call(value, symbol), false));

  let base = '';
  let braces = ['{', '}'];
  let isArrayLike = false;
  let formatter = () => [];

  if (Array.isArray(value)) {
    isArrayLike = true;
    const prefix = constructorName !== 'Array' || tag ? getPrefix(constructorName, tag, 'Array', `(${value.length})`) : '';
    braces = [`${prefix}[`, ']'];
    keys = keys.filter(key => !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length);
    formatter = () => formatArrayLike(ctx, value, level, value.length, null);
  } else if (typeof value === 'function') {
    base = functionBase(value, constructorName, tag);
    keys = keys.filter(key => key !== 'prototype');
    if (keys.length === 0 && symbols.length === 0) {
      return stylize(ctx, base, 'special');
    }
  } else if (isTypedArray(value)) {
    isArrayLike = true;
    const length = typedArrayLength.call(value);
    const name = constructorName || typedArrayTag.call(value);
    braces = [`${getPrefix(name, tag === name ? '' : tag, typedArrayTag.call(value), `(${length})`)}[`, ']'];
    keys = keys.filter(key => !/^(0|[1-9][0-9]*)$/.test(key));
    formatter = () => formatArrayLike(ctx, value, level, length, i => value[i]);
  } else if (isMap(value)) {
    braces = [`${getPrefix(constructorName, tag, 'Map', `(${mapSize.call(value)})`)}{`, '}'];
    formatter = () => {
      const output = [];
      for (const [key, item] of Map.prototype.entries.call(value)) {
        if (output.length >= ctx.maxArrayLength) {
          output.push(`... ${mapSize.call(value) - output.length} more items`);
          break;
        }
        output.push(`${formatNested(ctx, key, level)} => ${formatNested(ctx, item, level)}`);
      }
      return output;
    };
  } else if (isSet(value)) {
    braces = [`${getPrefix(constructorName, tag, 'Set', `(${setSize.call(value)})`)}{`, '}'];
    isArrayLike = true;
    formatter = () => {
      const output = [];
      for (const item of Set.prototype.values.call(value)) {
        if (output.length >= ctx.maxArrayLength) {
          output.push(`... ${setSize.call(value) - output.length} more items`);
          break;
        }
        output.push(formatNested(ctx, item, level));
      }
      return output;
    };
  } else if (isError(value)) {
    base = formatErrorValue(ctx, value, level);
    keys = keys.filter(key => key !== 'stack' && key !== 'message');
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else if (isRegExp(value)) {
    base = stylize(ctx, RegExp.prototype.toString.call(value), 'regexp');
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else if (isDate(value)) {
    const time = Date.prototype.getTime.call(value);
    base = stylize(ctx, Number.isNaN(time) ? 'Invalid Date' : Date.prototype.toISOString.call(value), 'date');
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else if (isPromise(value)) {
    braces = [`${getPrefix(constructorName, tag, 'Promise')}{`, '}'];
    formatter = () => {
      const [state, result] = native.promiseState(value);
      if (state === 0) {
        return [stylize(ctx, '<pending>', 'special')];
      }
      const text = formatNested(ctx, result, level);
      return [state === 2 ? `${stylize(ctx, '<rejected>', 'special')} ${text}` : text];
    };
  } else if (isArrayBuffer(value)) {
    braces = [`${getPrefix(constructorName, tag, 'ArrayBuffer')}{`, '}'];
    formatter = () => {
      const bytes = new Uint8Array(value);
      const shown = Array.from(bytes.slice(0, 50), byte => byte.toString(16).padStart(2, '0')).join(' ');
      const more = bytes.length > 50 ? ` ... ${bytes.length - 50} more bytes` : '';
      return [`[Uint8Contents]: <${shown}${more}>`, `byteLength: ${formatPrimitive(ctx, bytes.length)}`];
    };
  } else if (value instanceof WeakMap || value instanceof WeakSet) {
    braces = [`${getPrefix(constructorName, tag, 'Object')}{`, '}'];
    formatter = () => [stylize(ctx, '<items unknown>', 'special')];
  } else if (isModuleNamespace(value)) {
    braces = [`[Module: null prototype] {`, '}'];
    keys = safe(() => Object.getOwnPropertyNames(value), []);
    formatter = () => [];
  } else if (value instanceof Number || value instanceof String || value instanceof Boolean ||
             value instanceof BigInt || value instanceof Symbol) {
    const primitive = value.valueOf();
    const type = typeof primitive === 'bigint' ? 'BigInt' : (typeof primitive).replace(/^./, c => c.toUpperCase());
    base = `[${type}: ${formatPrimitive(Object.assign({}, ctx), primitive)}]`;
    if (typeof primitive === 'string') {
      keys = keys.filter(key => !/^(0|[1-9][0-9]*)$/.test(key));
    }
    if (keys.length === 0 && symbols.length === 0) {
      return base;
    }
  } else {
    if (constructorName === 'Object' && !tag) {
      braces = ['{', '}'];
    } else {
      braces = [`${getPrefix(constructorName, tag, 'Object')}{`, '}'];
    }
  }

  if (level > ctx.depth) {
    const name = Array.isArray(value) ? 'Array' : (constructorName || tag || 'Object');
    return stylize(ctx, `[${name}]`, 'special');
  }

  ctx.seen.push(value);
  let output;
  try {
    output = formatter();
    for (const key of keys) {
      output.push(formatProperty(ctx, value, level, key));
    }
    for (const symbol of symbols) {
      output.push(formatProperty(ctx, value, level, symbol));
    }
  } finally {
    ctx.seen.pop();
  }
  return reduceToSingleString(ctx, output, base, braces, isArrayLike, value);
}

// Puts the short entries of long arrays on several columns.
function groupArrayElements(ctx, output, value) {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = output.length;
  if (outputLength > 0 && output[outputLength - 1].startsWith('... ')) {
    outputLength--;
  }
  const separatorSpace = 2;
  const lengths = [];
  for (let i = 0; i < outputLength; i++) {
    const length = stripAnsi(output[i]).length;
    lengths.push(length);
    totalLength += length + separatorSpace;
    maxLength = Math.max(maxLength, length);
  }
  const actualMax = maxLength + separatorSpace;
  if (actualMax * 3 + ctx.indentation < ctx.breakLength &&
      (totalLength / actualMax > 5 || maxLength <= 6)) {
    const averageBias = Math.sqrt(actualMax - totalLength / output.length);
    const biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    const columns = Math.min(
      Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentation) / actualMax),
      12,
      15
    );
    if (columns <= 1) {
      return output;
    }
    const maxLineLength = [];
    for (let i = 0; i < columns; i++) {
      let lineLength = 0;
      for (let j = i; j < outputLength; j += columns) {
        lineLength = Math.max(lineLength, lengths[j]);
      }
      maxLineLength.push(lineLength + separatorSpace);
    }
    const numeric = value !== undefined && Array.isArray(value) &&
      value.slice(0, outputLength).every(item => typeof item === 'number' || typeof item === 'bigint');
    const grouped = [];
    for (let i = 0; i < outputLength; i += columns) {
      const max = Math.min(i + columns, outputLength);
      let line = '';
      let j = i;
      for (; j < max - 1; j++) {
        const padding = maxLineLength[j - i] + output[j].length - lengths[j];
        line += numeric ? `${output[j]}, `.padStart(padding, ' ') : `${output[j]}, `.padEnd(padding, ' ');
      }
      if (numeric) {
        const padding = maxLineLength[j - i] + output[j].length - lengths[j] - separatorSpace;
        line += output[j].padStart(padding, ' ');
      } else {
        line += output[j];
      }
      grouped.push(line);
    }
    if (outputLength < output.length) {
      grouped.push(output[outputLength]);
    }
    return grouped;
  }
  return output;
}

function reduceToSingleString(ctx, output, base, braces, isArrayLike, value) {
  const prefix = base ? `${base} ` : '';
  if (output.length === 0) {
    return `${prefix}${braces[0]}${braces[1]}`;
  }
  const entries = output.length;
  if (isArrayLike && entries > 6) {
    output = groupArrayElements(ctx, output, value);
  }
  if (entries === output.length) {
    const start = output.length + ctx.indentation + braces[0].length + base.length + 10;
    let totalLength = start + output.length;
    const fits = totalLength <= ctx.breakLength && output.every(entry => {
      totalLength += stripAnsi(entry).length;
      return totalLength <= ctx.breakLength;
    });
    if (fits && !base.includes('\n')) {
      const joined = output.join(', ');
      if (!joined.includes('\n')) {
        return `${prefix}${braces[0]} ${joined} ${braces[1]}`;
      }
    }
  }
  const indentation = `\n${' '.repeat(ctx.indentation)}`;
  return `${prefix}${braces[0]}${indentation}  ${output.join(`,${indentation}  `)}${indentation}${braces[1]}`;
}

/***************
 * Error stack *
 ***************/

function parseStack(stack) {
  if (typeof stack !== 'string') {
    return [];
  }
  const frames = [];
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:(.*?) \((.*)\)|(.*))$/.exec(line);
    if (!match) {
      continue;
    }
    const name = match[1] !== undefined ? match[1] : '';
    const location = match[1] !== undefined ? match[2] : match[3];
    const position = /^(.*):(\d+):(\d+)$/.exec(location);
    frames.push(position
      ? { name, location, file: position[1], line: Number(position[2]), column: Number(position[3]) }
      : { name, location, file: location, line: 0, column: 0 });
  }
  // Frames below the evaluation of the cell belong to the kernel
  const evalIndex = frames.findIndex(frame => frame.name === 'evalScript' && frame.file === 'native');
  const userFrames = evalIndex >= 0 ? frames.slice(0, evalIndex) : frames;
  // So do the native functions called by the kernel, like apply for timers
  return userFrames.filter((frame, i) => {
    const caller = userFrames[i + 1];
    const calledByKernel = frame.file === 'native' && caller !== undefined && RUNTIME_FILES.has(caller.file);
    return !RUNTIME_FILES.has(frame.file) && !calledByKernel;
  });
}

function formatFrame(frame, colors) {
  const isCell = cellSources.has(frame.file);
  const location = colors ? (isCell ? color('cyan', frame.location) : color('gray', frame.location)) : frame.location;
  if (frame.name === '<eval>' || frame.name === '') {
    return `    at ${location}`;
  }
  return `    at ${frame.name} (${location})`;
}

/*************
 * Execution *
 *************/

// Source lines of the executed cells, to show the code in tracebacks.
const cellSources = new Map();
let silentCount = 0;

// The state of the cell being executed.
let state = null;

// Holds the value of the last result, like the REPL of Node.js.
let lastValue;
Object.defineProperty(global, '_', {
  configurable: true,
  enumerable: false,
  get() {
    return lastValue;
  },
  set(value) {
    // Assigning _ disables the automatic assignment
    Object.defineProperty(global, '_', { value, writable: true, configurable: true, enumerable: true });
  }
});

function setLastValue(value) {
  const descriptor = Object.getOwnPropertyDescriptor(global, '_');
  if (descriptor && descriptor.get) {
    lastValue = value;
  }
}

function errorParts(error, prefix = '') {
  let ename;
  let evalue;
  let frames = [];
  if (error !== null && typeof error === 'object' && (isError(error) || ('stack' in error && 'message' in error))) {
    ename = safe(() => String(error.name), 'Error') || 'Error';
    evalue = safe(() => String(error.message), '');
    frames = parseStack(safe(() => error.stack, ''));
  } else {
    ename = 'Uncaught';
    evalue = inspect(error, { colors: false });
  }

  // QuickJS does not keep the position of the code when it checks for the
  // interruptions in loops: the innermost frame of an interruption points at
  // the start of the function, so it is left out.
  const interrupted = ename === 'InternalError' && evalue === 'interrupted';
  if (interrupted) {
    frames = frames.slice(1);
  }

  const traceback = [];
  // Show the line of code where the error happened
  const top = interrupted ? undefined : frames.find(frame => cellSources.has(frame.file));
  if (top && top.line > 0) {
    const line = cellSources.get(top.file)[top.line - 1];
    if (line !== undefined && line.trim() !== '') {
      const column = Math.max(0, Math.min(top.column - 1, line.length));
      const padding = line.slice(0, column).replace(/[^\t]/g, ' ');
      traceback.push(color('cyan', `${top.file}:${top.line}`));
      traceback.push(line);
      traceback.push(padding + color('red', color('bold', '^')));
      traceback.push('');
    }
  }
  const header = ename === 'Uncaught'
    ? `${color('red', color('bold', prefix ? `${prefix}` : 'Uncaught'))} ${evalue}`
    : `${prefix ? `${color('red', prefix)} ` : ''}${color('red', color('bold', ename))}${evalue ? `: ${evalue}` : ''}`;
  traceback.push(header);
  for (const frame of frames) {
    traceback.push(formatFrame(frame, true));
  }
  return { ename, evalue, traceback };
}

function recordError(current, error, prefix = '') {
  const parts = errorParts(error, prefix);
  if (current === null || current.error) {
    // The cell already failed: report the other errors on stderr
    native.publishStream('stderr', parts.traceback.join('\n') + '\n');
    return;
  }
  current.error = parts;
  native.publishError(parts.ename, parts.evalue, JSON.stringify(parts.traceback));
  // Like an uncaught exception in a script, an error stops the event loop
  clearTimers();
}

async function run(code, filename, current) {
  const { source, suppress, docs } = transformCell(code);
  let completion;
  try {
    completion = await native.evalScript(source, filename);
  } catch (error) {
    recordError(current, error);
    return;
  }
  registerDocs(docs);
  const value = completion ? completion.value : undefined;
  if (value === undefined || suppress) {
    return;
  }
  setLastValue(value);
  if (current.silent) {
    return;
  }
  let bundle;
  try {
    bundle = mimeBundle(value);
  } catch (error) {
    recordError(current, error);
    return;
  }
  native.publishExecutionResult(current.executionCount, serializeBundle(bundle.data), JSON.stringify(bundle.metadata));
}

function makeInterruptError() {
  const error = new Error('interrupted');
  error.name = 'InternalError';
  return error;
}

/*****************
 * Cell rewriting *
 *****************/

// QuickJS evaluates cells as global scripts. The top-level declarations of a
// cell are turned into var declarations so that cells can be executed again
// without "redeclaration" errors, and static imports into dynamic imports.

const PARSE_OPTIONS = {
  ecmaVersion: 'latest',
  allowAwaitOutsideFunction: true,
  allowHashBang: true
};

function parseCell(code) {
  for (const sourceType of ['module', 'script']) {
    const comments = [];
    try {
      const ast = acorn.parse(code, Object.assign({ sourceType, onComment: comments }, PARSE_OPTIONS));
      return { ast, comments };
    } catch (e) {
      // try the next source type
    }
  }
  return null;
}

function importToDynamic(node, code) {
  const source = code.slice(node.source.start, node.source.end);
  const attributes = node.attributes && node.attributes.length
    ? `, { with: { ${node.attributes.map(attribute => code.slice(attribute.start, attribute.end)).join(', ')} } }`
    : '';
  const call = `await import(${source}${attributes})`;
  const specifiers = node.specifiers || [];
  const parts = [];
  if (specifiers.length === 0) {
    parts.push(`${call};`);
  } else {
    const namespace = specifiers.find(specifier => specifier.type === 'ImportNamespaceSpecifier');
    const defaultSpecifier = specifiers.find(specifier => specifier.type === 'ImportDefaultSpecifier');
    if (namespace) {
      parts.push(`var ${namespace.local.name} = ${call};`);
      if (defaultSpecifier) {
        parts.push(`var ${defaultSpecifier.local.name} = ${namespace.local.name}.default;`);
      }
    } else {
      const properties = [];
      if (defaultSpecifier) {
        properties.push(`default: ${defaultSpecifier.local.name}`);
      }
      for (const specifier of specifiers) {
        if (specifier.type !== 'ImportSpecifier') {
          continue;
        }
        const imported = specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : JSON.stringify(specifier.imported.value);
        properties.push(imported === specifier.local.name ? imported : `${imported}: ${specifier.local.name}`);
      }
      parts.push(`var { ${properties.join(', ')} } = ${call};`);
    }
  }
  // Keep the line numbers of the cell for the tracebacks
  const newlines = code.slice(node.start, node.end).split('\n').length - 1;
  return parts.join(' ') + '\n'.repeat(newlines);
}

function findDocComment(comments, code, start) {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment.end > start) {
      continue;
    }
    if (comment.type === 'Block' && comment.value.startsWith('*') && code.slice(comment.end, start).trim() === '') {
      return comment.value
        .replace(/^\*/, '')
        .split('\n')
        .map(line => line.replace(/^\s*\* ?/, ''))
        .join('\n')
        .trim();
    }
    return null;
  }
  return null;
}

function transformCell(code) {
  const result = { source: code, suppress: false, docs: [] };

  // An object literal at the start of a cell would be parsed as a block
  if (/^\s*\{/.test(code) && /\}\s*$/.test(code)) {
    const wrapped = `(${code}\n)`;
    const parsed = safe(() => acorn.parse(wrapped, Object.assign({ sourceType: 'script' }, PARSE_OPTIONS)));
    if (parsed && parsed.body.length === 1 && parsed.body[0].type === 'ExpressionStatement') {
      result.source = wrapped;
      return result;
    }
  }

  const parsed = parseCell(code);
  if (parsed === null) {
    // QuickJS reports the syntax error
    return result;
  }
  const { ast, comments } = parsed;
  const edits = [];

  const declare = (node, outer) => {
    const doc = findDocComment(comments, code, outer.start);
    switch (node.type) {
      case 'VariableDeclaration':
        if (node.kind === 'let' || node.kind === 'const') {
          edits.push({ start: node.start, end: node.start + node.kind.length, text: 'var'.padEnd(node.kind.length) });
        }
        if (doc) {
          for (const declaration of node.declarations) {
            if (declaration.id.type === 'Identifier') {
              result.docs.push({ name: declaration.id.name, doc });
            }
          }
        }
        break;
      case 'ClassDeclaration':
        edits.push({ start: node.start, end: node.start, text: `var ${node.id.name} = ` });
        edits.push({ start: node.end, end: node.end, text: ';' });
        if (doc) {
          result.docs.push({ name: node.id.name, doc });
        }
        break;
      case 'FunctionDeclaration':
        if (doc && node.id) {
          result.docs.push({ name: node.id.name, doc });
        }
        break;
    }
  };

  for (const node of ast.body) {
    switch (node.type) {
      case 'VariableDeclaration':
      case 'ClassDeclaration':
      case 'FunctionDeclaration':
        declare(node, node);
        break;
      case 'ImportDeclaration':
        edits.push({ start: node.start, end: node.end, text: importToDynamic(node, code) });
        break;
      case 'ExportNamedDeclaration':
        if (node.declaration) {
          edits.push({ start: node.start, end: node.declaration.start, text: '' });
          declare(node.declaration, node);
        } else {
          edits.push({ start: node.start, end: node.end, text: '' });
        }
        break;
      case 'ExportDefaultDeclaration':
        edits.push({ start: node.start, end: node.declaration.start, text: '' });
        if (node.declaration.type === 'ClassDeclaration' || node.declaration.type === 'FunctionDeclaration') {
          if (node.declaration.id) {
            declare(node.declaration, node);
          }
        }
        break;
    }
  }

  const last = ast.body[ast.body.length - 1];
  if (last && last.type === 'ExpressionStatement') {
    result.suppress = code.slice(last.start, last.end).trimEnd().endsWith(';');
  }

  // Apply the edits from the end, so that the offsets stay valid
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let source = code;
  for (const edit of edits) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  result.source = source;
  return result;
}

/********
 * Docs *
 ********/

// Documentation of values, from the JSDoc comments of the cells and of the
// functions of the kernel. Shown when inspecting a value.
const docStore = new WeakMap();
// The functions of the kernel, whose source code is not shown
const kernelApi = new WeakSet();

function registerDocs(docs) {
  for (const { name, doc } of docs) {
    const value = safe(() => indirectEval(name));
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      docStore.set(value, doc);
    }
  }
}

function setDoc(value, doc) {
  docStore.set(value, doc);
  kernelApi.add(value);
  return value;
}

/***********
 * Display *
 ***********/

const REPR_METHODS = [
  ['_toHtml', 'text/html'],
  ['_toMarkdown', 'text/markdown'],
  ['_toSvg', 'image/svg+xml'],
  ['_toPng', 'image/png'],
  ['_toJpeg', 'image/jpeg'],
  ['_toLatex', 'text/latex'],
  ['_toJson', 'application/json']
];

const jupyterDisplaySymbol = Symbol.for('Jupyter.display');

function isJsonMimeType(mimeType) {
  return mimeType === 'application/json' || /\+json$/.test(mimeType);
}

function normalizeBundle(bundle) {
  const data = {};
  if (bundle === null || typeof bundle !== 'object') {
    throw new TypeError('A MIME bundle must be an object mapping MIME types to data');
  }
  for (const [mimeType, content] of Object.entries(bundle)) {
    if (content === undefined) {
      continue;
    }
    const bytes = toBytes(content);
    if (bytes !== null) {
      data[mimeType] = bytesToBase64(bytes);
    } else if (isJsonMimeType(mimeType)) {
      data[mimeType] = content;
    } else {
      data[mimeType] = String(content);
    }
  }
  return data;
}

function mimeBundle(value, colors = true) {
  let data = {};
  const metadata = {};
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    if (typeof value[jupyterDisplaySymbol] === 'function') {
      Object.assign(data, normalizeBundle(value[jupyterDisplaySymbol]()));
    }
    if (typeof value._toMime === 'function') {
      Object.assign(data, normalizeBundle(value._toMime()));
    }
    for (const [method, mimeType] of REPR_METHODS) {
      if (!(mimeType in data) && typeof value[method] === 'function') {
        Object.assign(data, normalizeBundle({ [mimeType]: value[method]() }));
      }
    }
  }
  if (!('text/plain' in data)) {
    data['text/plain'] = inspect(value, { colors });
  }
  return { data, metadata };
}

// Values which can not be serialized to JSON fall back to text/plain.
function serializeBundle(data) {
  try {
    return JSON.stringify(data);
  } catch (e) {
    const fallback = {};
    for (const [mimeType, content] of Object.entries(data)) {
      if (!isJsonMimeType(mimeType)) {
        fallback[mimeType] = content;
      }
    }
    return JSON.stringify(fallback);
  }
}

let displayIdCount = 0;

function newDisplayId() {
  displayIdCount++;
  const random = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `xquickjs-${random}-${displayIdCount}`;
}

function publishDisplay(data, options, update) {
  const metadata = options.metadata || {};
  const transient = options.id ? { display_id: options.id } : {};
  const publish = update ? native.updateDisplayData : native.displayData;
  publish(serializeBundle(data), JSON.stringify(metadata), JSON.stringify(transient));
}

class DisplayHandle {
  constructor(id, mimeType, placeholder) {
    this.id = id;
    // Handles of display.html, display.markdown... update with the same type
    Object.defineProperty(this, 'mimeType', { value: mimeType, enumerable: false });
    Object.defineProperty(this, 'placeholder', { value: placeholder, enumerable: false });
  }

  _bundle(value, options) {
    if (options.raw) {
      return normalizeBundle(value);
    }
    if (this.mimeType && typeof value === 'string') {
      return { [this.mimeType]: value, 'text/plain': this.placeholder || value };
    }
    return mimeBundle(value).data;
  }

  /** Shows a value in a new output, which is updated with the other outputs of this handle. */
  display(value, options = {}) {
    publishDisplay(this._bundle(value, options), Object.assign({}, options, { id: this.id }), false);
  }

  /** Replaces the content of the outputs of this handle. */
  update(value, options = {}) {
    publishDisplay(this._bundle(value, options), Object.assign({}, options, { id: this.id }), true);
  }
}

function resolveOptions(options) {
  const resolved = Object.assign({}, options);
  if (resolved.id === true) {
    resolved.id = newDisplayId();
  } else if (resolved.id !== undefined && resolved.id !== false) {
    resolved.id = String(resolved.id);
  } else {
    delete resolved.id;
  }
  return resolved;
}

function display(value, options = {}) {
  const resolved = resolveOptions(options);
  if (resolved.raw) {
    publishDisplay(normalizeBundle(value), resolved, false);
  } else {
    publishDisplay(mimeBundle(value).data, resolved, false);
  }
  return resolved.id ? new DisplayHandle(resolved.id, resolved.mimeType, resolved.placeholder) : undefined;
}

// Accepts either a string, or a tagged template: display.html`<b>${x}</b>`.
// Like with String.raw, the backslashes of templates are kept, for LaTeX.
function templateContent(content, values) {
  if (Array.isArray(content) && Array.isArray(content.raw)) {
    let text = content.raw[0];
    for (let i = 0; i < values.length; i++) {
      text += String(values[i]) + content.raw[i + 1];
    }
    return { text, options: {} };
  }
  return { text: content, options: values[0] || {} };
}

function mimeHelper(mimeType, description) {
  const helper = function (content, ...rest) {
    const { text, options } = templateContent(content, rest);
    const placeholder = mimeType === 'text/plain' ? undefined : `<${description}>`;
    const data = { [mimeType]: text };
    if (placeholder) {
      data['text/plain'] = placeholder;
    }
    return display(data, Object.assign({}, options, { raw: true, mimeType, placeholder }));
  };
  return helper;
}

function imageHelper(mimeType) {
  return function (content, options = {}) {
    const bytes = toBytes(content);
    const data = bytes !== null ? bytesToBase64(bytes) : String(content);
    const metadata = {};
    if (options.width || options.height) {
      metadata[mimeType] = {};
      if (options.width) {
        metadata[mimeType].width = options.width;
      }
      if (options.height) {
        metadata[mimeType].height = options.height;
      }
    }
    return display({ [mimeType]: data, 'text/plain': `<${mimeType} image>` },
                   Object.assign({}, options, { raw: true, metadata }));
  };
}

const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};

display.html = setDoc(mimeHelper('text/html', 'HTML'),
  'Displays HTML.\n\ndisplay.html(content, options?) or display.html`<b>${value}</b>`');
display.markdown = setDoc(mimeHelper('text/markdown', 'Markdown'),
  'Displays Markdown.\n\ndisplay.markdown(content, options?) or display.markdown`# ${title}`');
display.svg = setDoc(mimeHelper('image/svg+xml', 'SVG'),
  'Displays an SVG image from its source.\n\ndisplay.svg(content, options?)');
display.latex = setDoc(mimeHelper('text/latex', 'LaTeX'),
  'Displays LaTeX, for example display.latex("$e^{i\\\\pi} + 1 = 0$").');
display.text = setDoc(mimeHelper('text/plain', 'text'),
  'Displays plain text.\n\ndisplay.text(content, options?)');
display.json = setDoc(function json(content, options = {}) {
  return display({ 'application/json': content, 'text/plain': inspect(content) },
                 Object.assign({}, options, { raw: true }));
}, 'Displays JSON data as an interactive tree.\n\ndisplay.json(value, options?)');
display.png = setDoc(imageHelper('image/png'),
  'Displays a PNG image from its bytes (Uint8Array, ArrayBuffer) or base64 data.\n\n' +
  'display.png(data, { width?, height? })');
display.jpeg = setDoc(imageHelper('image/jpeg'),
  'Displays a JPEG image from its bytes (Uint8Array, ArrayBuffer) or base64 data.\n\n' +
  'display.jpeg(data, { width?, height? })');
display.image = setDoc(function image(path, options = {}) {
  const extension = String(path).split('.').pop().toLowerCase();
  const mimeType = options.type || IMAGE_TYPES[extension];
  if (!mimeType) {
    throw new TypeError(`Unknown image type for '${path}', pass it with the type option`);
  }
  const bytes = new Uint8Array(native.readFile(String(path)));
  if (mimeType === 'image/svg+xml') {
    return display.svg(new TextDecoder().decode(bytes), options);
  }
  return imageHelper(mimeType)(bytes, options);
}, 'Displays an image file.\n\ndisplay.image(path, { width?, height?, type? })');
display.mime = setDoc(function mime(bundle, options = {}) {
  return display(bundle, Object.assign({}, options, { raw: true }));
}, 'Displays a MIME bundle, an object mapping MIME types to data.\n\n' +
   'display.mime({ "text/html": "<b>Hi</b>", "text/plain": "Hi" }, options?)');
display.clear = setDoc(function clear(wait = false) {
  native.clearOutput(Boolean(wait));
}, 'Clears the outputs of the cell. With wait=true, waits for the next output to clear them.');

setDoc(display,
  'Displays a value with its richest representation.\n\n' +
  'display(value, { id?, metadata? })\n\n' +
  'Objects can define _toHtml(), _toMarkdown(), _toSvg(), _toPng(), _toJpeg(), _toLatex(),\n' +
  '_toJson() or _toMime() methods, or a [Symbol.for("Jupyter.display")]() method returning\n' +
  'a MIME bundle. With { id: true } (or a string), returns a handle to update the output:\n\n' +
  '    const handle = display("Loading...", { id: true });\n' +
  '    handle.update("Done!");\n\n' +
  'See also display.html, display.markdown, display.svg, display.png, display.image,\n' +
  'display.latex, display.json, display.mime and display.clear.');

/***********
 * Console *
 ***********/

function applyFormat(args, colors) {
  let used = 1;
  const text = args[0].replace(/%([sdifjoOc%])/g, (match, specifier) => {
    if (specifier === '%') {
      return '%';
    }
    if (used >= args.length) {
      return match;
    }
    const arg = args[used++];
    switch (specifier) {
      case 's':
        if (typeof arg === 'string') {
          return arg;
        }
        if (typeof arg === 'bigint') {
          return `${arg}n`;
        }
        if (arg !== null && typeof arg === 'object') {
          return inspect(arg, { depth: 1, colors });
        }
        return String(arg);
      case 'd':
      case 'i': {
        if (typeof arg === 'bigint') {
          return `${arg}n`;
        }
        if (typeof arg === 'symbol') {
          return 'NaN';
        }
        const number = specifier === 'i' ? parseInt(arg) : Number(arg);
        return formatPrimitive({ colors }, number);
      }
      case 'f':
        return typeof arg === 'symbol' ? 'NaN' : formatPrimitive({ colors }, parseFloat(arg));
      case 'j':
        return safe(() => JSON.stringify(arg), '[Circular]');
      case 'o':
        return inspect(arg, { colors, depth: 4 });
      case 'O':
        return inspect(arg, { colors });
      case 'c':
        return '';
    }
    return match;
  });
  return { text, used };
}

function format(args, colors = true) {
  const parts = [];
  let rest = args;
  if (typeof args[0] === 'string' && args.length > 1 && args[0].includes('%')) {
    const { text, used } = applyFormat(args, colors);
    parts.push(text);
    rest = args.slice(used);
  }
  for (const arg of rest) {
    parts.push(typeof arg === 'string' ? arg : inspect(arg, { colors }));
  }
  return parts.join(' ');
}

let groupIndentation = '';

function writeStream(name, text) {
  if (groupIndentation) {
    text = text.split('\n').map(line => groupIndentation + line).join('\n');
  }
  native.publishStream(name, text + '\n');
}

function formatDuration(milliseconds) {
  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(3)}s`;
  }
  return `${milliseconds.toFixed(3)}ms`;
}

function tableCell(value) {
  if (typeof value === 'string') {
    return value;
  }
  return inspect(value, { depth: 0, breakLength: Infinity });
}

function consoleTable(data, properties) {
  if (data === null || typeof data !== 'object') {
    console.log(data);
    return;
  }
  const indexHeader = '(index)';
  const valuesHeader = 'Values';
  const rows = [];
  const columns = [];
  let hasValues = false;
  const addColumn = column => {
    if (!columns.includes(column)) {
      columns.push(column);
    }
  };
  const entries = isMap(data)
    ? Array.from(Map.prototype.entries.call(data))
    : isSet(data) ? Array.from(Set.prototype.values.call(data), (value, i) => [i, value]) : Object.entries(data);
  for (const [index, row] of entries) {
    const cells = {};
    if (row !== null && typeof row === 'object' && !isDate(row) && !isRegExp(row)) {
      for (const [key, value] of Object.entries(row)) {
        if (properties && !properties.includes(key)) {
          continue;
        }
        addColumn(key);
        cells[key] = tableCell(value);
      }
    } else {
      hasValues = true;
      cells[valuesHeader] = tableCell(row);
    }
    rows.push({ index: tableCell(index), cells });
  }
  if (properties) {
    columns.splice(0, columns.length, ...properties.map(String));
  }
  if (hasValues) {
    columns.push(valuesHeader);
  }

  // Plain text, drawn like Node.js does
  const headers = [indexHeader, ...columns];
  const table = rows.map(row => [row.index, ...columns.map(column => (column in row.cells ? row.cells[column] : ''))]);
  const widths = headers.map((header, i) => Math.max(header.length, ...table.map(row => row[i].length)) + 2);
  const center = (text, width) => {
    const left = Math.floor((width - text.length) / 2);
    return ' '.repeat(left) + text + ' '.repeat(width - text.length - left);
  };
  const line = (left, middle, right) => left + widths.map(width => '─'.repeat(width)).join(middle) + right;
  const plain = [
    line('┌', '┬', '┐'),
    '│' + headers.map((header, i) => center(header, widths[i])).join('│') + '│',
    line('├', '┼', '┤'),
    ...table.map(row => '│' + row.map((cell, i) => center(cell, widths[i])).join('│') + '│'),
    line('└', '┴', '┘')
  ].join('\n');

  const html = [
    '<table>',
    '<thead><tr>' + headers.map(header => `<th>${escapeHtml(header)}</th>`).join('') + '</tr></thead>',
    '<tbody>',
    ...table.map(row => '<tr>' + row.map((cell, i) => (i === 0 ? `<th>${escapeHtml(cell)}</th>` : `<td>${escapeHtml(cell)}</td>`)).join('') + '</tr>'),
    '</tbody>',
    '</table>'
  ].join('\n');

  display({ 'text/html': html, 'text/plain': plain }, { raw: true });
}

const counts = new Map();
const consoleTimers = new Map();

const console = {
  log(...args) {
    writeStream('stdout', format(args));
  },
  info(...args) {
    writeStream('stdout', format(args));
  },
  debug(...args) {
    writeStream('stdout', format(args));
  },
  error(...args) {
    writeStream('stderr', format(args));
  },
  warn(...args) {
    writeStream('stderr', format(args));
  },
  trace(...args) {
    const frames = parseStack(new Error().stack).map(frame => formatFrame(frame, true));
    writeStream('stderr', [`Trace${args.length ? `: ${format(args)}` : ''}`, ...frames].join('\n'));
  },
  dir(value, options = {}) {
    writeStream('stdout', inspect(value, Object.assign({ colors: true }, options)));
  },
  dirxml(...args) {
    writeStream('stdout', format(args));
  },
  table(data, properties) {
    consoleTable(data, properties);
  },
  group(...label) {
    if (label.length) {
      writeStream('stdout', format(label));
    }
    groupIndentation += '  ';
  },
  groupCollapsed(...label) {
    console.group(...label);
  },
  groupEnd() {
    groupIndentation = groupIndentation.slice(2);
  },
  time(label = 'default') {
    label = String(label);
    if (consoleTimers.has(label)) {
      console.warn(`Warning: Label '${label}' already exists for console.time()`);
      return;
    }
    consoleTimers.set(label, native.now());
  },
  timeLog(label = 'default', ...data) {
    label = String(label);
    if (!consoleTimers.has(label)) {
      console.warn(`Warning: No such label '${label}' for console.timeLog()`);
      return;
    }
    const elapsed = native.now() - consoleTimers.get(label);
    console.log(`${label}: ${formatDuration(elapsed)}`, ...data);
  },
  timeEnd(label = 'default') {
    label = String(label);
    if (!consoleTimers.has(label)) {
      console.warn(`Warning: No such label '${label}' for console.timeEnd()`);
      return;
    }
    console.timeLog(label);
    consoleTimers.delete(label);
  },
  count(label = 'default') {
    label = String(label);
    const count = (counts.get(label) || 0) + 1;
    counts.set(label, count);
    console.log(`${label}: ${count}`);
  },
  countReset(label = 'default') {
    counts.delete(String(label));
  },
  assert(condition, ...data) {
    if (condition) {
      return;
    }
    if (typeof data[0] === 'string') {
      data[0] = `Assertion failed: ${data[0]}`;
    } else {
      data.unshift('Assertion failed');
    }
    console.error(...data);
  },
  clear() {
    native.clearOutput(false);
  }
};

/**********
 * Timers *
 **********/

// Timers run in the event loop of the cell which created them: a cell is done
// when its code completed and all its timers have fired, like a script.
const timers = new Map();
let timerCount = 0;

function addTimer(callback, delay, args, repeat) {
  if (typeof callback !== 'function') {
    throw new TypeError('The "callback" argument must be a function');
  }
  delay = Number(delay);
  if (!(delay >= 1 && delay <= 2147483647)) {
    delay = repeat ? 1 : 0;
  }
  const id = ++timerCount;
  timers.set(id, { callback, args, due: native.now() + delay, repeat: repeat ? delay : 0 });
  return id;
}

function clearTimer(id) {
  timers.delete(Number(id));
}

function clearTimers() {
  timers.clear();
}

/*********
 * Input *
 *********/

function prompt(message = '', defaultValue = undefined) {
  const value = native.inputRequest(String(message), false);
  if (value === '' && defaultValue !== undefined) {
    return String(defaultValue);
  }
  return value;
}

prompt.password = setDoc(function password(message = '') {
  return native.inputRequest(String(message), true);
}, 'Asks for a password, the input is hidden.\n\nprompt.password(message?)');

/**********************
 * Other web globals *
 **********************/

class DOMException extends Error {
  constructor(message = '', name = 'Error') {
    super(message);
    Object.defineProperty(this, 'name', { value: name, writable: true, configurable: true });
  }
}

class TextEncoder {
  get encoding() {
    return 'utf-8';
  }

  encode(input = '') {
    const text = String(input);
    const bytes = [];
    for (const char of text) {
      let code = char.codePointAt(0);
      if (code >= 0xd800 && code <= 0xdfff) {
        code = 0xfffd;
      }
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code < 0x10000) {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      } else {
        bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }
    return new Uint8Array(bytes);
  }
}

class TextDecoder {
  constructor(label = 'utf-8') {
    if (!/^utf-?8$/i.test(label)) {
      throw new RangeError(`The "${label}" encoding is not supported`);
    }
  }

  get encoding() {
    return 'utf-8';
  }

  decode(input) {
    if (input === undefined) {
      return '';
    }
    const bytes = toBytes(input);
    if (bytes === null) {
      throw new TypeError('The input must be an ArrayBuffer or a typed array');
    }
    const chunks = [];
    let codes = [];
    let i = 0;
    while (i < bytes.length) {
      const byte = bytes[i];
      let code = 0xfffd;
      let size = 1;
      if (byte < 0x80) {
        code = byte;
      } else if (byte >= 0xc2 && byte < 0xe0 && i + 1 < bytes.length) {
        code = ((byte & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
        size = 2;
      } else if (byte >= 0xe0 && byte < 0xf0 && i + 2 < bytes.length) {
        code = ((byte & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
        size = 3;
      } else if (byte >= 0xf0 && byte < 0xf5 && i + 3 < bytes.length) {
        code = ((byte & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        size = 4;
      }
      codes.push(code);
      i += size;
      if (codes.length >= 8192) {
        chunks.push(String.fromCodePoint(...codes));
        codes = [];
      }
    }
    chunks.push(String.fromCodePoint(...codes));
    return chunks.join('');
  }
}

function btoa(data) {
  const text = String(data);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new DOMException('Invalid character', 'InvalidCharacterError');
    }
    bytes[i] = code;
  }
  return bytesToBase64(bytes);
}

function atob(data) {
  const bytes = base64ToBytes(data);
  let text = '';
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return text;
}

function structuredClone(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new DOMException(`${String(value)} could not be cloned.`, 'DataCloneError');
    }
    return value;
  }
  if (seen.has(value)) {
    return seen.get(value);
  }
  let copy;
  if (Array.isArray(value)) {
    copy = [];
    seen.set(value, copy);
    value.forEach((item, i) => {
      copy[i] = structuredClone(item, seen);
    });
    return copy;
  }
  if (isDate(value)) {
    return new Date(value.getTime());
  }
  if (isRegExp(value)) {
    return new RegExp(value.source, value.flags);
  }
  if (isArrayBuffer(value)) {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    return new value.constructor(value);
  }
  if (isMap(value)) {
    copy = new Map();
    seen.set(value, copy);
    for (const [key, item] of value) {
      copy.set(structuredClone(key, seen), structuredClone(item, seen));
    }
    return copy;
  }
  if (isSet(value)) {
    copy = new Set();
    seen.set(value, copy);
    for (const item of value) {
      copy.add(structuredClone(item, seen));
    }
    return copy;
  }
  if (isError(value)) {
    copy = new Error(value.message);
    copy.name = value.name;
    return copy;
  }
  copy = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) {
    copy[key] = structuredClone(item, seen);
  }
  return copy;
}

const timeOrigin = native.now();
const performance = {
  timeOrigin: Date.now(),
  now() {
    return native.now() - timeOrigin;
  }
};

/***********
 * Globals *
 ***********/

setDoc(console.log, 'Prints values to the standard output, like console.log in Node.js.\n\n' +
  'Supports the format specifiers %s, %d, %i, %f, %j, %o, %O and %c.');
setDoc(console.table, 'Displays tabular data (an array or an object of rows) as a table.\n\n' +
  'console.table(data, columns?)');
setDoc(prompt, 'Asks the user for some input, and returns it as a string.\n\n' +
  'prompt(message?, defaultValue?)\n\nSee also prompt.password.');

defineGlobal('console', console);
defineGlobal('print', setDoc(function print(...args) {
  console.log(...args);
}, 'Prints values to the standard output, same as console.log.'));
defineGlobal('display', display);
defineGlobal('clearOutput', setDoc(function clearOutput(wait = false) {
  native.clearOutput(Boolean(wait));
}, 'Clears the outputs of the cell. With wait=true, waits for the next output to clear them.'));
defineGlobal('prompt', prompt);
defineGlobal('setTimeout', setDoc(function setTimeout(callback, delay = 0, ...args) {
  return addTimer(callback, delay, args, false);
}, 'Calls a function after a delay in milliseconds.\n\nsetTimeout(callback, delay?, ...args) returns an id for clearTimeout.\n\n' +
   'The cell runs until all its timers have fired.'));
defineGlobal('setInterval', setDoc(function setInterval(callback, delay = 0, ...args) {
  return addTimer(callback, delay, args, true);
}, 'Calls a function repeatedly, every delay milliseconds.\n\nsetInterval(callback, delay?, ...args) returns an id for clearInterval.\n\n' +
   'The cell runs until the interval is cleared, or until the kernel is interrupted.'));
defineGlobal('setImmediate', function setImmediate(callback, ...args) {
  return addTimer(callback, 0, args, false);
});
defineGlobal('clearTimeout', function clearTimeout(id) {
  clearTimer(id);
});
defineGlobal('clearInterval', function clearInterval(id) {
  clearTimer(id);
});
defineGlobal('clearImmediate', function clearImmediate(id) {
  clearTimer(id);
});
defineGlobal('queueMicrotask', function queueMicrotask(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('The "callback" argument must be a function');
  }
  Promise.resolve().then(() => callback());
});
defineGlobal('DOMException', DOMException);
defineGlobal('TextEncoder', TextEncoder);
defineGlobal('TextDecoder', TextDecoder);
defineGlobal('btoa', btoa);
defineGlobal('atob', atob);
defineGlobal('structuredClone', function (value) {
  return structuredClone(value);
});
if (typeof global.performance === 'undefined') {
  defineGlobal('performance', performance);
}

/*********
 * Comms *
 *********/

const comms = new Map();
const commTargets = new Map();

function newCommId() {
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

// Comm buffers are passed to the interpreter as ArrayBuffers
function toArrayBuffers(buffers) {
  return (buffers || []).map(buffer => {
    const bytes = toBytes(buffer);
    if (bytes === null) {
      throw new TypeError('Comm buffers must be ArrayBuffers or typed arrays');
    }
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
      return bytes.buffer;
    }
    return bytes.slice().buffer;
  });
}

/**
 * A communication channel with the frontend.
 *
 * new Jupyter.Comm(targetName, data?, metadata?, buffers?) opens a comm.
 * Set comm.onMsg = (data, buffers, metadata) => {} and
 * comm.onClose = (data, metadata) => {} to handle the messages of the frontend.
 */
class Comm {
  constructor(targetName, data = {}, metadata = {}, buffers = [], options = {}) {
    this.targetName = String(targetName);
    this.commId = options.commId || newCommId();
    this.onMsg = null;
    this.onClose = null;
    Object.defineProperty(this, '_closed', { value: false, writable: true });
    comms.set(this.commId, this);
    if (!options.fromFrontend) {
      native.commOpen(this.targetName, this.commId, JSON.stringify(data), JSON.stringify(metadata),
                      toArrayBuffers(buffers));
    }
  }

  get closed() {
    return this._closed;
  }

  /** Sends a message to the frontend. */
  send(data = {}, metadata = {}, buffers = []) {
    if (this._closed) {
      throw new Error(`The comm ${this.commId} is closed`);
    }
    native.commSend(this.commId, JSON.stringify(data), JSON.stringify(metadata), toArrayBuffers(buffers));
  }

  /** Closes the comm. */
  close(data = {}, metadata = {}, buffers = []) {
    if (this._closed) {
      return;
    }
    this._closed = true;
    comms.delete(this.commId);
    native.commClose(this.commId, JSON.stringify(data), JSON.stringify(metadata), toArrayBuffers(buffers));
  }

  /**
   * Handles the comms opened by the frontend for a target:
   * Jupyter.Comm.registerTarget(name, (comm, { data, metadata, buffers }) => {})
   */
  static registerTarget(targetName, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('The "callback" argument must be a function');
    }
    commTargets.set(String(targetName), callback);
    native.commRegisterTarget(String(targetName));
  }
}

function parentMessageId() {
  const header = safe(() => JSON.parse(native.parentHeader()), {});
  return (header && header.msg_id) || '';
}

const widgets = widgetsFactory({ Comm, display, inspect, parentMessageId, setDoc, toBytes });

defineGlobal('Jupyter', Object.freeze({ Comm, widgets }));

/**************
 * Completion *
 **************/

const KEYWORDS = [
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import',
  'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'static', 'super', 'switch', 'this',
  'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield'
];
const KEYWORD_SET = new Set(KEYWORDS);

const MEMBER_RE = new RegExp(
  `(${IDENTIFIER}(?:\\s*\\??\\.\\s*${IDENTIFIER}|\\[(?:\\d+|'[^']*'|"[^"]*")\\])*)\\s*\\??\\.\\s*(${IDENTIFIER})?$`, 'u');
const STRING_MEMBER_RE = new RegExp(`(?:'[^'\\\\]*'|"[^"\\\\]*"|\`[^\`\\\\$]*\`)\\s*\\.\\s*(${IDENTIFIER})?$`, 'u');
const ARRAY_MEMBER_RE = new RegExp(`\\]\\s*\\.\\s*(${IDENTIFIER})?$`, 'u');
const NAME_RE = new RegExp(`(${IDENTIFIER})$`, 'u');

function valueType(value) {
  if (typeof value === 'function') {
    return isClass(value) ? 'class' : 'function';
  }
  if (value !== null && typeof value === 'object') {
    return isModuleNamespace(value) ? 'module' : 'instance';
  }
  return 'property';
}

// The properties of an object and of its prototypes, with their types and
// the depth of the prototype defining them. Getters are not called.
function propertyTypes(object) {
  const names = new Map();
  names.depths = new Map();
  if (object === null || object === undefined) {
    return names;
  }
  let current = typeof object === 'object' || typeof object === 'function' ? object : Object(object);
  for (let depth = 0; current !== null && depth < 100; depth++) {
    const keys = safe(() => Object.getOwnPropertyNames(current), []);
    for (const key of keys) {
      if (names.has(key) || !IDENTIFIER_RE.test(key)) {
        continue;
      }
      const descriptor = safe(() => Object.getOwnPropertyDescriptor(current, key));
      names.set(key, descriptor && hasOwn(descriptor, 'value') ? valueType(descriptor.value) : 'property');
      names.depths.set(key, depth);
    }
    current = safe(() => Object.getPrototypeOf(current), null);
  }
  return names;
}

// The own properties come first, then the ones of the prototypes, like the
// methods of a class before the ones of Object.
function sortNames(names, depths) {
  const rank = name => (name.startsWith('__') ? 2 : name.startsWith('_') ? 1 : 0);
  const depth = name => (depths && depths.has(name) ? depths.get(name) : 0);
  return names.sort((a, b) =>
    rank(a) - rank(b) || depth(a) - depth(b) ||
    a.localeCompare(b, 'en', { sensitivity: 'base' }) || (a < b ? -1 : 1));
}

function filterNames(types, prefix) {
  let names = Array.from(types.keys()).filter(name => name.startsWith(prefix));
  if (names.length === 0) {
    const lower = prefix.toLowerCase();
    names = Array.from(types.keys()).filter(name => name.toLowerCase().startsWith(lower));
  }
  if (!prefix.startsWith('_')) {
    names = names.filter(name => !name.startsWith('__'));
  }
  return sortNames(names, types.depths);
}

function completionReply(code, cursor, prefix, types) {
  const matches = filterNames(types, prefix);
  const start = toCodePointIndex(code, cursor - prefix.length);
  const end = toCodePointIndex(code, cursor);
  return {
    matches,
    cursor_start: start,
    cursor_end: end,
    metadata: {
      _jupyter_types_experimental: matches.map(text => ({ start, end, text, type: types.get(text) }))
    }
  };
}

function isInStringOrComment(text) {
  // A rough scan, enough to avoid completing inside strings and comments
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = null;
      }
    } else if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0) {
        return true;
      }
      i = end;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) {
        return true;
      }
      i = end + 1;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
    }
  }
  return quote !== null;
}

function complete(code, cursorPosition) {
  const cursor = toUtf16Index(code, cursorPosition);
  const before = code.slice(0, cursor);
  const empty = { matches: [], cursor_start: cursorPosition, cursor_end: cursorPosition, metadata: {} };

  let match = STRING_MEMBER_RE.exec(before);
  if (match) {
    return completionReply(code, cursor, match[1] || '', propertyTypes(''));
  }
  if (isInStringOrComment(before)) {
    return empty;
  }
  if (new RegExp(`\\)\\s*\\??\\.\\s*(${IDENTIFIER})?$`, 'u').test(before)) {
    // Members of the result of a call: the call is not evaluated
    return empty;
  }
  match = MEMBER_RE.exec(before);
  if (match) {
    if (/\.\s*$/.test(before.slice(0, match.index))) {
      return empty;
    }
    const object = safe(() => indirectEval(match[1]));
    return completionReply(code, cursor, match[2] || '', propertyTypes(object));
  }
  match = ARRAY_MEMBER_RE.exec(before);
  if (match) {
    return completionReply(code, cursor, match[1] || '', propertyTypes([]));
  }
  match = NAME_RE.exec(before);
  const prefix = match ? match[1] : '';
  if (!prefix && /[\p{ID_Continue}$]$/u.test(before)) {
    return empty;
  }
  const types = propertyTypes(global);
  for (const keyword of KEYWORDS) {
    if (!types.has(keyword)) {
      types.set(keyword, 'keyword');
      types.depths.set(keyword, 0);
    }
  }
  return completionReply(code, cursor, prefix, types);
}

/**************
 * Inspection *
 **************/

const MDN_URL = 'https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/';
const BUILTINS = [
  'AggregateError', 'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array',
  'Boolean', 'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float16Array',
  'Float32Array', 'Float64Array', 'Function', 'Int16Array', 'Int32Array', 'Int8Array', 'Iterator',
  'JSON', 'Map', 'Math', 'Number', 'Object', 'Promise', 'Proxy', 'RangeError', 'ReferenceError',
  'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer', 'String', 'Symbol', 'SyntaxError', 'TypeError',
  'URIError', 'Uint16Array', 'Uint32Array', 'Uint8Array', 'Uint8ClampedArray', 'WeakMap', 'WeakRef',
  'WeakSet', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'eval',
  'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'unescape'
];

// Maps the built-in objects and their methods to their MDN page
const mdnPages = new WeakMap();

function registerMdnPages(object, page) {
  for (const key of safe(() => Object.getOwnPropertyNames(object), [])) {
    if (key === 'constructor' || key === 'prototype') {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (descriptor && typeof descriptor.value === 'function' && !mdnPages.has(descriptor.value)) {
      mdnPages.set(descriptor.value, `${page}/${key}`);
    }
  }
}

for (const name of BUILTINS) {
  const value = global[name];
  if (value === undefined || value === null || mdnPages.has(value)) {
    continue;
  }
  if (typeof value === 'object' || typeof value === 'function') {
    mdnPages.set(value, name);
    if (name !== 'globalThis') {
      registerMdnPages(value, name);
      if (typeof value === 'function' && value.prototype) {
        registerMdnPages(value.prototype, name);
      }
    }
  }
}
const TypedArray = Object.getPrototypeOf(Int8Array);
mdnPages.set(TypedArray, 'TypedArray');
registerMdnPages(TypedArray, 'TypedArray');
registerMdnPages(TypedArray.prototype, 'TypedArray');

function mdnPage(value) {
  if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
    if (mdnPages.has(value)) {
      return MDN_URL + mdnPages.get(value);
    }
    if (typeof value === 'object') {
      const constructor = safe(() => Object.getPrototypeOf(value).constructor);
      if (constructor && mdnPages.has(constructor) && constructor !== Object) {
        return MDN_URL + mdnPages.get(constructor);
      }
    }
  }
  return null;
}

const CHAIN_RE = new RegExp(`${IDENTIFIER}(?:\\s*\\??\\.\\s*${IDENTIFIER})*`, 'gu');

// Finds the expression to inspect at the cursor: the dotted name under the
// cursor, or the function called by the innermost unclosed parenthesis.
function expressionAt(code, cursor) {
  for (const match of code.matchAll(CHAIN_RE)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start <= cursor && cursor <= end) {
      // Stop at the end of the identifier under the cursor
      const rest = code.slice(cursor, end);
      const identifierEnd = cursor + (new RegExp(`^[\\p{ID_Continue}$\\u200c\\u200d]*`, 'u').exec(rest)[0].length);
      const expression = code.slice(start, identifierEnd).replace(/\s+/g, '');
      if (/\.\s*$/.test(code.slice(0, start)) || KEYWORD_SET.has(expression)) {
        break;
      }
      return expression;
    }
    if (start > cursor) {
      break;
    }
  }
  let depth = 0;
  for (let i = cursor - 1; i >= 0; i--) {
    const char = code[i];
    if (char === ')') {
      depth++;
    } else if (char === '(') {
      if (depth === 0) {
        const match = new RegExp(`(${IDENTIFIER}(?:\\s*\\??\\.\\s*${IDENTIFIER})*)\\s*$`, 'u').exec(code.slice(0, i));
        if (match && !KEYWORD_SET.has(match[1])) {
          return match[1].replace(/\s+/g, '');
        }
        return null;
      }
      depth--;
    }
  }
  return null;
}

function parameters(source, node) {
  if (!node || !node.params) {
    return '';
  }
  return node.params.map(param => source.slice(param.start, param.end)).join(', ');
}

// The signature of a function, from its source code.
function signature(name, fn) {
  const source = safe(() => Function.prototype.toString.call(fn), '');
  if (/\{\s*\[native code\]\s*\}$/.test(source)) {
    return `${name}(${fn.length > 0 ? '…' : ''})`;
  }
  if (isClass(fn)) {
    const wrapped = `(${source})`;
    const ast = safe(() => acorn.parse(wrapped, Object.assign({ sourceType: 'script' }, PARSE_OPTIONS)));
    const body = ast && ast.body[0].expression.body.body;
    const constructor = body && body.find(member => member.kind === 'constructor');
    return `new ${name}(${constructor ? parameters(wrapped, constructor.value) : ''})`;
  }
  for (const wrapped of [`(${source})`, `({${source}})`]) {
    const ast = safe(() => acorn.parse(wrapped, Object.assign({ sourceType: 'script' }, PARSE_OPTIONS)));
    if (!ast) {
      continue;
    }
    let node = ast.body[0].expression;
    if (node.type === 'ObjectExpression') {
      node = node.properties[0] && node.properties[0].value;
    }
    if (node) {
      const prefix = (node.async ? 'async ' : '') + (node.generator ? '*' : '');
      return `${prefix}${name}(${parameters(wrapped, node)})`;
    }
  }
  return `${name}(…)`;
}

function inspectValue(expression, value, detailLevel) {
  const label = text => color('red', text.padEnd(11));
  const lines = [];
  const doc = value !== null && (typeof value === 'object' || typeof value === 'function') ? docStore.get(value) : undefined;
  const page = mdnPage(value);

  if (typeof value === 'function') {
    const source = safe(() => Function.prototype.toString.call(value), '');
    const isNative = /\{\s*\[native code\]\s*\}$/.test(source);
    const isKernelApi = kernelApi.has(value);
    if (!isKernelApi) {
      lines.push(`${label('Signature:')}${signature(expression, value)}`);
    }
    if (doc) {
      lines.push(`${label('Docstring:')}${doc.split('\n').join('\n' + ' '.repeat(11))}`);
    }
    lines.push(`${label('Type:')}${isClass(value) ? 'class' : getConstructorName(value) || 'Function'}`);
    if (!isNative && !isKernelApi && (detailLevel > 0 || source.split('\n').length <= 30)) {
      lines.push(`${label('Source:')}`);
      lines.push(source);
    }
  } else {
    const type = value === null ? 'null' : typeof value === 'object' ? getConstructorName(value) || 'Object' : typeof value;
    lines.push(`${label('Type:')}${type}`);
    const text = inspect(value, { colors: true, depth: detailLevel > 0 ? 4 : 2 });
    lines.push(`${label('Value:')}${text.split('\n').join('\n' + ' '.repeat(11))}`);
    if (typeof value === 'string' || Array.isArray(value)) {
      lines.push(`${label('Length:')}${value.length}`);
    } else if (isMap(value) || isSet(value)) {
      lines.push(`${label('Size:')}${value.size}`);
    }
    if (doc) {
      lines.push(`${label('Docstring:')}${doc.split('\n').join('\n' + ' '.repeat(11))}`);
    }
  }
  if (page) {
    lines.push(`${label('Docs:')}${page}`);
  }
  return lines.join('\n');
}

function inspectRequest(code, cursorPosition, detailLevel) {
  const cursor = toUtf16Index(code, cursorPosition);
  const expression = expressionAt(code, cursor);
  if (!expression) {
    return { found: false };
  }
  let value;
  try {
    value = indirectEval(expression);
  } catch (e) {
    return { found: false };
  }
  return { found: true, data: { 'text/plain': inspectValue(expression, value, detailLevel) }, metadata: {} };
}

/******************
 * Code completeness *
 ******************/

function isComplete(code) {
  if (code.trim() === '') {
    return { status: 'complete' };
  }
  let error = null;
  for (const sourceType of ['module', 'script']) {
    try {
      acorn.parse(code, Object.assign({ sourceType }, PARSE_OPTIONS));
      return { status: 'complete' };
    } catch (e) {
      error = e;
    }
  }
  const atEnd = typeof error.pos === 'number' && error.pos >= code.trimEnd().length;
  if (atEnd || /Unterminated (template|comment)/.test(error.message)) {
    const lines = code.split('\n');
    const last = lines[lines.length - 1];
    let indent = /^\s*/.exec(last)[0];
    if (/[{([]\s*$/.test(last)) {
      indent += '  ';
    }
    return { status: 'incomplete', indent };
  }
  return { status: 'invalid' };
}

/**********
 * Kernel *
 **********/

return {
  execute(code, executionCount, silent) {
    const filename = silent ? `<silent-${++silentCount}>` : `In[${executionCount}]`;
    cellSources.set(filename, code.split('\n'));
    const current = { executionCount, silent, done: false, error: null };
    state = current;
    groupIndentation = '';
    run(code, filename, current).then(
      () => {
        current.done = true;
      },
      error => {
        // Uncatchable errors, like interruptions, end up here
        current.done = true;
        recordError(current, error);
      }
    );
  },

  finish(interrupted) {
    const current = state;
    state = null;
    clearTimers();
    if (current !== null && current.error === null) {
      if (interrupted) {
        recordError(current, makeInterruptError());
      } else if (!current.done) {
        const error = new Error('the cell is waiting for a promise which can not be resolved anymore');
        error.name = 'UnsettledTopLevelAwait';
        recordError(current, error);
      }
    }
    if (current !== null && current.error !== null) {
      const { ename, evalue, traceback } = current.error;
      return JSON.stringify({ status: 'error', ename, evalue, traceback });
    }
    return JSON.stringify({ status: 'ok' });
  },

  nextTimerDelay() {
    if (timers.size === 0) {
      return -1;
    }
    let due = Infinity;
    for (const timer of timers.values()) {
      due = Math.min(due, timer.due);
    }
    return Math.max(0, due - native.now());
  },

  runNextTimer() {
    const now = native.now();
    let nextId = null;
    let next = null;
    for (const [id, timer] of timers) {
      if (timer.due <= now && (next === null || timer.due < next.due)) {
        nextId = id;
        next = timer;
      }
    }
    if (next === null) {
      return false;
    }
    if (next.repeat) {
      next.due = now + next.repeat;
    } else {
      timers.delete(nextId);
    }
    try {
      next.callback.apply(global, next.args);
    } catch (error) {
      recordError(state, error, 'Uncaught');
    }
    return true;
  },

  reportUncaught(error, inPromise) {
    recordError(state, error, inPromise ? 'Uncaught (in promise)' : 'Uncaught');
  },

  complete(code, cursorPosition) {
    return JSON.stringify(complete(code, cursorPosition));
  },

  inspect(code, cursorPosition, detailLevel) {
    return JSON.stringify(inspectRequest(code, cursorPosition, detailLevel));
  },

  isComplete(code) {
    return JSON.stringify(isComplete(code));
  },

  commOpened(targetName, commId, data, metadata, buffers) {
    const comm = new Comm(targetName, undefined, undefined, undefined, { commId, fromFrontend: true });
    const callback = commTargets.get(targetName);
    if (!callback) {
      comm.close();
      return;
    }
    try {
      callback(comm, { data: JSON.parse(data), metadata: JSON.parse(metadata), buffers });
    } catch (error) {
      recordError(state, error, 'Uncaught');
    }
  },

  commMessage(commId, data, metadata, buffers, isClose) {
    const comm = comms.get(commId);
    if (!comm) {
      return;
    }
    try {
      if (isClose) {
        comm._closed = true;
        comms.delete(commId);
        if (typeof comm.onClose === 'function') {
          comm.onClose(JSON.parse(data), JSON.parse(metadata));
        }
      } else if (typeof comm.onMsg === 'function') {
        comm.onMsg(JSON.parse(data), buffers, JSON.parse(metadata));
      }
    } catch (error) {
      recordError(state, error, 'Uncaught');
    }
  },

  evaluateExpression(expression) {
    try {
      const { data, metadata } = mimeBundle(indirectEval(expression), false);
      return serializeBundle({ status: 'ok', data, metadata });
    } catch (error) {
      const { ename, evalue, traceback } = errorParts(error);
      return JSON.stringify({ status: 'error', ename, evalue, traceback });
    }
  }
};
})
