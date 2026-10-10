/***************************************************************************
* Copyright (c) 2026, Jeremy Tuloup                                        *
* Copyright (c) Jupyter Development Team.                                  *
*                                                                          *
* Distributed under the terms of the BSD 3-Clause License.                 *
*                                                                          *
* The full license is in the file LICENSE, distributed with this software. *
****************************************************************************/

// Jupyter widgets for xeus-quickjs.
//
// Implements the protocol of ipywidgets 8, with the same API as the widgets
// of the JupyterLite JavaScript kernel (jupyterlite/javascript-kernel), from
// which the widget definitions are adapted.
//
// This script evaluates to a function called by the runtime of the kernel,
// which returns the widget classes, available as Jupyter.widgets.
(function (runtime) {
'use strict';

const { Comm, inspect, parentMessageId, setDoc, toBytes } = runtime;

const PROTOCOL_VERSION = '2.1.0';
const BASE_MODULE = '@jupyter-widgets/base';
const BASE_MODULE_VERSION = '2.0.0';
const CONTROLS_MODULE = '@jupyter-widgets/controls';
const CONTROLS_MODULE_VERSION = '2.0.0';
const OUTPUT_MODULE = '@jupyter-widgets/output';
const OUTPUT_MODULE_VERSION = '1.0.0';
const WIDGET_VIEW_MIMETYPE = 'application/vnd.jupyter.widget-view+json';
const REFERENCE_PREFIX = 'IPY_MODEL_';

// The widgets created by the kernel, by model id
const widgetsById = new Map();

const isBinary = value => value instanceof ArrayBuffer || ArrayBuffer.isView(value);

// Widgets are referenced by their model id in the state of other widgets,
// for instance the children of a box or the layout of a widget.
function serializeValue(value) {
  if (value instanceof Widget) {
    return REFERENCE_PREFIX + value.commId;
  }
  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }
  return value;
}

function deserializeValue(value) {
  if (typeof value === 'string' && value.startsWith(REFERENCE_PREFIX)) {
    return widgetsById.get(value.slice(REFERENCE_PREFIX.length)) || value;
  }
  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }
  return value;
}

// Binary values are sent as buffers, with their path in the state
function serializeState(state) {
  const serialized = {};
  const buffers = [];
  const bufferPaths = [];
  for (const [key, value] of Object.entries(state)) {
    if (isBinary(value)) {
      buffers.push(toBytes(value));
      bufferPaths.push([key]);
      serialized[key] = null;
    } else {
      serialized[key] = serializeValue(value);
    }
  }
  return { state: serialized, buffers, bufferPaths };
}

function sameValue(a, b) {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameValue(item, b[i]));
  }
  return false;
}

/**
 * Base class of the Jupyter widgets.
 *
 * The state of a widget is synchronized with the frontend. Its properties
 * can be read and assigned directly (slider.value = 10), or with get and set.
 * Listen to changes with widget.observe(callback, names?) or
 * widget.on('change:name', callback).
 */
class Widget {
  static modelName = 'WidgetModel';
  static viewName = null;
  static modelModule = BASE_MODULE;
  static modelModuleVersion = BASE_MODULE_VERSION;
  static viewModule = BASE_MODULE;
  static viewModuleVersion = BASE_MODULE_VERSION;
  static defaults = {};

  constructor(state = {}) {
    const ctor = this.constructor;
    const initial = Object.assign({}, collectDefaults(ctor), this._prepareState(state), modelState(ctor));
    Object.defineProperty(this, '_state', { value: initial });
    Object.defineProperty(this, '_listeners', { value: new Map() });
    Object.defineProperty(this, '_observers', { value: new Map() });
    defineTraits(ctor, initial);

    const { state: serialized, buffers, bufferPaths } = serializeState(initial);
    const comm = new Comm('jupyter.widget', { state: serialized, buffer_paths: bufferPaths },
                          { version: PROTOCOL_VERSION }, buffers);
    Object.defineProperty(this, '_comm', { value: comm });
    comm.onMsg = (data, buffers) => this._handleMessage(data, buffers);
    comm.onClose = data => {
      widgetsById.delete(comm.commId);
      this._trigger('close', data);
    };
    widgetsById.set(comm.commId, this);
  }

  /** The id of the model of the widget. */
  get commId() {
    return this._comm.commId;
  }

  /** Returns the value of a property. */
  get(name) {
    return this._state[name];
  }

  /** Sets one or several properties: set(name, value) or set({ name: value }). */
  set(nameOrState, value) {
    const updates = typeof nameOrState === 'string' ? { [nameOrState]: value } : nameOrState;
    const changes = [];
    for (const [key, next] of Object.entries(updates)) {
      const old = this._state[key];
      if (!sameValue(old, next)) {
        this._state[key] = next;
        changes.push([key, next, old]);
      }
    }
    if (changes.length === 0) {
      return;
    }
    const sent = {};
    for (const [key] of changes) {
      sent[key] = this._state[key];
    }
    this._send(sent);
    this._notify(changes);
  }

  /**
   * Calls a function when a property changes, with { name, new, old, owner, type }.
   * names is a property name or a list of names, all the properties by default.
   */
  observe(callback, names = '*') {
    for (const name of Array.isArray(names) ? names : [names]) {
      const event = name === '*' ? 'change' : `change:${name}`;
      let wrappers = this._observers.get(callback);
      if (!wrappers) {
        wrappers = new Map();
        this._observers.set(callback, wrappers);
      }
      if (wrappers.has(name)) {
        continue;
      }
      const wrapper = name === '*'
        ? changes => {
          for (const [changed, next, old] of changes) {
            callback({ name: changed, new: next, old, owner: this, type: 'change' });
          }
        }
        : (next, old) => callback({ name, new: next, old, owner: this, type: 'change' });
      wrappers.set(name, wrapper);
      this.on(event, wrapper);
    }
    return this;
  }

  /** Removes a callback added with observe. */
  unobserve(callback, names) {
    const wrappers = this._observers.get(callback);
    if (!wrappers) {
      return this;
    }
    const keys = names === undefined ? Array.from(wrappers.keys()) : Array.isArray(names) ? names : [names];
    for (const name of keys) {
      const wrapper = wrappers.get(name);
      if (wrapper) {
        this.off(name === '*' ? 'change' : `change:${name}`, wrapper);
        wrappers.delete(name);
      }
    }
    if (wrappers.size === 0) {
      this._observers.delete(callback);
    }
    return this;
  }

  /**
   * Listens to an event of the widget: 'change:name' (new, old), 'change'
   * (changes), 'close', and 'click' or 'custom' for some widgets.
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return this;
  }

  /** Removes an event listener. */
  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
    return this;
  }

  /** Sends a custom message to the frontend. */
  send(content, buffers = []) {
    if (!this._comm.closed) {
      this._comm.send({ method: 'custom', content }, {}, buffers);
    }
  }

  /** Closes the widget, which removes it from the frontend. */
  close() {
    this._comm.close();
  }

  _prepareState(state) {
    return Object.assign({}, state);
  }

  _send(state) {
    // A frontend without widget manager closes the comms: like ipywidgets,
    // the widgets keep their state without synchronizing it
    if (this._comm.closed) {
      return;
    }
    const { state: serialized, buffers, bufferPaths } = serializeState(state);
    this._comm.send({ method: 'update', state: serialized, buffer_paths: bufferPaths }, {}, buffers);
  }

  _notify(changes) {
    for (const [key, next, old] of changes) {
      this._trigger(`change:${key}`, next, old);
    }
    this._trigger('change', changes);
  }

  _trigger(event, ...args) {
    const listeners = this._listeners.get(event);
    if (!listeners) {
      return;
    }
    for (const callback of Array.from(listeners)) {
      callback.apply(this, args);
    }
  }

  _handleMessage(data, buffers) {
    switch (data.method) {
      case 'update': {
        const state = Object.assign({}, data.state);
        (data.buffer_paths || []).forEach((path, i) => {
          if (path.length === 1 && buffers && buffers[i]) {
            state[path[0]] = new Uint8Array(buffers[i]);
          }
        });
        const changes = [];
        for (const [key, value] of Object.entries(state)) {
          const next = deserializeValue(value);
          const old = this._state[key];
          if (!sameValue(old, next)) {
            this._state[key] = next;
            changes.push([key, next, old]);
          }
        }
        if (changes.length > 0) {
          this._notify(changes);
        }
        break;
      }
      case 'request_state':
        this._send(this._state);
        break;
      case 'custom':
        this._trigger('custom', data.content, buffers);
        break;
    }
  }

  [Symbol.for('Jupyter.display')]() {
    const ctor = this.constructor;
    if (ctor.viewName === null) {
      return { 'text/plain': this._repr() };
    }
    return {
      [WIDGET_VIEW_MIMETYPE]: { version_major: 2, version_minor: 0, model_id: this.commId },
      'text/plain': this._repr()
    };
  }

  _repr() {
    const shown = ['value', 'description', 'options', 'children'];
    const parts = [];
    for (const key of shown) {
      if (key in this._state && this._state[key] !== '' && key !== 'options') {
        parts.push(`${key}=${inspect(this._state[key], { depth: 0, breakLength: Infinity })}`);
      }
    }
    return `${this.constructor.name}(${parts.join(', ')})`;
  }
}

function collectDefaults(ctor) {
  const chain = [];
  for (let current = ctor; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    if (Object.prototype.hasOwnProperty.call(current, 'defaults')) {
      chain.unshift(current.defaults);
    }
  }
  const defaults = {};
  for (const values of chain) {
    for (const [key, value] of Object.entries(values)) {
      // Copy the arrays, as they are mutable
      defaults[key] = Array.isArray(value) ? value.slice() : value;
    }
  }
  return defaults;
}

function modelState(ctor) {
  const state = {
    _model_name: ctor.modelName,
    _model_module: ctor.modelModule,
    _model_module_version: ctor.modelModuleVersion
  };
  if (ctor.viewName !== null) {
    state._view_name = ctor.viewName;
    state._view_module = ctor.viewModule;
    state._view_module_version = ctor.viewModuleVersion;
  }
  return state;
}

// Properties are accessors of the prototype of the widget classes
function defineTraits(ctor, state) {
  for (const key of Object.keys(state)) {
    if (key.startsWith('_') || key in ctor.prototype) {
      continue;
    }
    Object.defineProperty(ctor.prototype, key, {
      get() {
        return this.get(key);
      },
      set(value) {
        this.set(key, value);
      },
      configurable: true
    });
  }
}

/** The layout of a widget: new Layout({ width: '300px', border: '1px solid' }). */
class Layout extends Widget {
  static modelName = 'LayoutModel';
  static viewName = 'LayoutView';
}

/** The style of a widget, e.g. { button_color: 'lightgreen' } or { description_width: 'initial' }. */
class Style extends Widget {
  static modelName = 'StyleModel';
  static viewName = 'StyleView';
}

function styleClass(modelName, module = CONTROLS_MODULE) {
  const cls = class extends Style {
    static modelName = modelName;
    static modelModule = module;
    static modelModuleVersion = CONTROLS_MODULE_VERSION;
  };
  Object.defineProperty(cls, 'name', { value: modelName.replace(/Model$/, '') });
  return cls;
}

const styles = {};
for (const name of ['DescriptionStyleModel', 'SliderStyleModel', 'ProgressStyleModel', 'ButtonStyleModel',
                    'CheckboxStyleModel', 'ToggleButtonStyleModel', 'ToggleButtonsStyleModel', 'TextStyleModel',
                    'HTMLStyleModel', 'HTMLMathStyleModel', 'LabelStyleModel']) {
  const cls = styleClass(name);
  styles[cls.name] = cls;
}

/** A widget with a view in the frontend, a layout and a style. */
class DOMWidget extends Widget {
  static styleClass = null;
  static defaults = { layout: null, style: null, _dom_classes: [], tabbable: null, tooltip: null };

  _prepareState(state) {
    const prepared = super._prepareState(state);
    // Plain objects are turned into layout and style widgets
    if (prepared.layout && !(prepared.layout instanceof Widget)) {
      prepared.layout = new Layout(prepared.layout);
    }
    const StyleClass = this.constructor.styleClass;
    if (prepared.style && !(prepared.style instanceof Widget)) {
      prepared.style = StyleClass ? new StyleClass(prepared.style) : new Style(prepared.style);
    }
    if (prepared.layout === undefined || prepared.layout === null) {
      prepared.layout = new Layout();
    }
    if ((prepared.style === undefined || prepared.style === null) && StyleClass) {
      prepared.style = new StyleClass();
    }
    return prepared;
  }

  /** Adds a CSS class to the view of the widget. */
  addClass(name) {
    const classes = this.get('_dom_classes') || [];
    if (!classes.includes(name)) {
      this.set('_dom_classes', [...classes, name]);
    }
    return this;
  }

  /** Removes a CSS class from the view of the widget. */
  removeClass(name) {
    this.set('_dom_classes', (this.get('_dom_classes') || []).filter(item => item !== name));
    return this;
  }
}

const DESCRIPTION = { description: '', description_allow_html: false };

// Defines a widget class from its models and default state
function widgetClass(name, base, options) {
  const cls = class extends base {
    static modelName = options.model;
    static viewName = options.view === undefined ? base.viewName : options.view;
    static modelModule = options.module || CONTROLS_MODULE;
    static modelModuleVersion = options.moduleVersion || CONTROLS_MODULE_VERSION;
    static viewModule = options.module || CONTROLS_MODULE;
    static viewModuleVersion = options.moduleVersion || CONTROLS_MODULE_VERSION;
    static styleClass = options.style === undefined ? base.styleClass : options.style;
    static defaults = options.defaults || {};
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

const SLIDER = Object.assign({}, DESCRIPTION, {
  value: 0, min: 0, max: 100, step: 1, orientation: 'horizontal', readout: true,
  continuous_update: true, disabled: false, behavior: 'drag-tap'
});
const PROGRESS = Object.assign({}, DESCRIPTION, { value: 0, min: 0, max: 100, bar_style: '', orientation: 'horizontal' });
const NUMERIC_TEXT = Object.assign({}, DESCRIPTION, { value: 0, step: 1, continuous_update: false, disabled: false });
const TEXT = Object.assign({}, DESCRIPTION, { value: '', placeholder: '', continuous_update: true, disabled: false });
const BOX = { children: [], box_style: '' };

const IntSlider = widgetClass('IntSlider', DOMWidget, {
  model: 'IntSliderModel', view: 'IntSliderView', style: styles.SliderStyle,
  defaults: Object.assign({}, SLIDER, { readout_format: 'd' })
});
const FloatSlider = widgetClass('FloatSlider', DOMWidget, {
  model: 'FloatSliderModel', view: 'FloatSliderView', style: styles.SliderStyle,
  defaults: Object.assign({}, SLIDER, { value: 0.0, max: 10.0, step: 0.1, readout_format: '.2f' })
});
const FloatLogSlider = widgetClass('FloatLogSlider', DOMWidget, {
  model: 'FloatLogSliderModel', view: 'FloatLogSliderView', style: styles.SliderStyle,
  defaults: Object.assign({}, SLIDER, { value: 1.0, min: 0.0, max: 4.0, base: 10.0, step: 0.1, readout_format: '.3g' })
});
const IntRangeSlider = widgetClass('IntRangeSlider', DOMWidget, {
  model: 'IntRangeSliderModel', view: 'IntRangeSliderView', style: styles.SliderStyle,
  defaults: Object.assign({}, SLIDER, { value: [0, 1], readout_format: 'd' })
});
const FloatRangeSlider = widgetClass('FloatRangeSlider', DOMWidget, {
  model: 'FloatRangeSliderModel', view: 'FloatRangeSliderView', style: styles.SliderStyle,
  defaults: Object.assign({}, SLIDER, { value: [0.0, 1.0], step: 0.1, readout_format: '.2f' })
});
const Play = widgetClass('Play', DOMWidget, {
  model: 'PlayModel', view: 'PlayView', style: styles.DescriptionStyle,
  defaults: Object.assign({}, DESCRIPTION, {
    value: 0, min: 0, max: 100, step: 1, repeat: false, playing: false, show_repeat: true, interval: 100, disabled: false
  })
});
const IntProgress = widgetClass('IntProgress', DOMWidget, {
  model: 'IntProgressModel', view: 'ProgressView', style: styles.ProgressStyle, defaults: PROGRESS
});
const FloatProgress = widgetClass('FloatProgress', DOMWidget, {
  model: 'FloatProgressModel', view: 'ProgressView', style: styles.ProgressStyle,
  defaults: Object.assign({}, PROGRESS, { value: 0.0, max: 10.0 })
});
const IntText = widgetClass('IntText', DOMWidget, {
  model: 'IntTextModel', view: 'IntTextView', style: styles.DescriptionStyle, defaults: NUMERIC_TEXT
});
const FloatText = widgetClass('FloatText', DOMWidget, {
  model: 'FloatTextModel', view: 'FloatTextView', style: styles.DescriptionStyle,
  defaults: Object.assign({}, NUMERIC_TEXT, { value: 0.0, step: 0.1 })
});
const BoundedIntText = widgetClass('BoundedIntText', DOMWidget, {
  model: 'BoundedIntTextModel', view: 'IntTextView', style: styles.DescriptionStyle,
  defaults: Object.assign({}, NUMERIC_TEXT, { min: 0, max: 100 })
});
const BoundedFloatText = widgetClass('BoundedFloatText', DOMWidget, {
  model: 'BoundedFloatTextModel', view: 'FloatTextView', style: styles.DescriptionStyle,
  defaults: Object.assign({}, NUMERIC_TEXT, { value: 0.0, step: 0.1, min: 0.0, max: 100.0 })
});
const Checkbox = widgetClass('Checkbox', DOMWidget, {
  model: 'CheckboxModel', view: 'CheckboxView', style: styles.CheckboxStyle,
  defaults: Object.assign({}, DESCRIPTION, { value: false, indent: true, disabled: false })
});
const ToggleButton = widgetClass('ToggleButton', DOMWidget, {
  model: 'ToggleButtonModel', view: 'ToggleButtonView', style: styles.ToggleButtonStyle,
  defaults: Object.assign({}, DESCRIPTION, { value: false, tooltip: '', icon: '', button_style: '', disabled: false })
});
const Valid = widgetClass('Valid', DOMWidget, {
  model: 'ValidModel', view: 'ValidView', style: styles.DescriptionStyle,
  defaults: Object.assign({}, DESCRIPTION, { value: false, readout: 'Invalid', disabled: false })
});
const Text = widgetClass('Text', DOMWidget, {
  model: 'TextModel', view: 'TextView', style: styles.TextStyle, defaults: TEXT
});
const Textarea = widgetClass('Textarea', DOMWidget, {
  model: 'TextareaModel', view: 'TextareaView', style: styles.TextStyle, defaults: Object.assign({}, TEXT, { rows: null })
});
const Password = widgetClass('Password', DOMWidget, {
  model: 'PasswordModel', view: 'PasswordView', style: styles.TextStyle, defaults: TEXT
});
const Combobox = widgetClass('Combobox', DOMWidget, {
  model: 'ComboboxModel', view: 'ComboboxView', style: styles.TextStyle,
  defaults: Object.assign({}, TEXT, { options: [], ensure_option: false })
});
const Label = widgetClass('Label', DOMWidget, {
  model: 'LabelModel', view: 'LabelView', style: styles.LabelStyle, defaults: Object.assign({}, DESCRIPTION, { value: '' })
});
const HTML = widgetClass('HTML', DOMWidget, {
  model: 'HTMLModel', view: 'HTMLView', style: styles.HTMLStyle,
  defaults: Object.assign({}, DESCRIPTION, { value: '', placeholder: '' })
});
const HTMLMath = widgetClass('HTMLMath', DOMWidget, {
  model: 'HTMLMathModel', view: 'HTMLMathView', style: styles.HTMLMathStyle,
  defaults: Object.assign({}, DESCRIPTION, { value: '', placeholder: '' })
});
const ColorPicker = widgetClass('ColorPicker', DOMWidget, {
  model: 'ColorPickerModel', view: 'ColorPickerView', style: styles.DescriptionStyle,
  defaults: Object.assign({}, DESCRIPTION, { value: '#000000', concise: false, disabled: false })
});
const Image = widgetClass('Image', DOMWidget, {
  model: 'ImageModel', view: 'ImageView', style: null,
  defaults: { value: new Uint8Array(0), format: 'png', width: '', height: '' }
});

/** A button. Use button.onClick(callback) to react to the clicks. */
class Button extends widgetClass('Button', DOMWidget, {
  model: 'ButtonModel', view: 'ButtonView', style: styles.ButtonStyle,
  defaults: { description: '', tooltip: '', icon: '', button_style: '', disabled: false }
}) {
  /** Calls a function when the button is clicked. */
  onClick(callback) {
    return this.on('click', callback);
  }

  _handleMessage(data, buffers) {
    super._handleMessage(data, buffers);
    if (data.method === 'custom' && data.content && data.content.event === 'click') {
      this._trigger('click', this);
    }
  }
}

// Selection widgets keep the options as labels, and the selection as an index
function selectionClass(name, model, view, style, defaults = {}, multiple = false) {
  const base = widgetClass(name, DOMWidget, {
    model, view, style,
    defaults: Object.assign({}, DESCRIPTION, { _options_labels: [], index: multiple ? [] : null, disabled: false }, defaults)
  });
  const cls = class extends base {
    _prepareState(state) {
      const prepared = super._prepareState(state);
      if (prepared.options !== undefined) {
        prepared._options_labels = Array.from(prepared.options, String);
        delete prepared.options;
      }
      const labels = prepared._options_labels || [];
      if (prepared.value !== undefined) {
        prepared.index = multiple
          ? Array.from(prepared.value, label => labels.indexOf(String(label))).filter(i => i >= 0)
          : labels.indexOf(String(prepared.value));
        delete prepared.value;
      }
      if (prepared.index === undefined) {
        prepared.index = multiple ? (defaults.index || []).slice() : labels.length > 0 ? 0 : null;
      }
      return prepared;
    }

    /** The labels of the options. */
    get options() {
      return (this.get('_options_labels') || []).slice();
    }

    set options(labels) {
      this.set({ _options_labels: Array.from(labels, String), index: multiple ? [] : labels.length > 0 ? 0 : null });
    }

    /** The label of the selected option(s). */
    get value() {
      const labels = this.get('_options_labels') || [];
      const index = this.get('index');
      if (multiple) {
        return (index || []).map(i => labels[i]);
      }
      return index === null || index === undefined ? null : labels[index];
    }

    set value(value) {
      const labels = this.get('_options_labels') || [];
      this.set('index', multiple
        ? Array.from(value, label => labels.indexOf(String(label))).filter(i => i >= 0)
        : value === null ? null : labels.indexOf(String(value)));
    }

    _notify(changes) {
      super._notify(changes);
      // Selecting an option also changes the value
      const indexChange = changes.find(([key]) => key === 'index');
      if (indexChange) {
        const labels = this.get('_options_labels') || [];
        const toValue = index => (multiple ? (index || []).map(i => labels[i]) : index === null ? null : labels[index]);
        this._trigger('change:value', toValue(indexChange[1]), toValue(indexChange[2]));
      }
    }
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

const SELECTION_SLIDER = { orientation: 'horizontal', readout: true, continuous_update: true, behavior: 'drag-tap' };

const Dropdown = selectionClass('Dropdown', 'DropdownModel', 'DropdownView', styles.DescriptionStyle);
const RadioButtons = selectionClass('RadioButtons', 'RadioButtonsModel', 'RadioButtonsView', styles.DescriptionStyle);
const Select = selectionClass('Select', 'SelectModel', 'SelectView', styles.DescriptionStyle, { rows: 5 });
const ToggleButtons = selectionClass('ToggleButtons', 'ToggleButtonsModel', 'ToggleButtonsView',
                                     styles.ToggleButtonsStyle, { tooltips: [], button_style: '', icons: [] });
const SelectionSlider = selectionClass('SelectionSlider', 'SelectionSliderModel', 'SelectionSliderView',
                                       styles.SliderStyle, SELECTION_SLIDER);
const SelectMultiple = selectionClass('SelectMultiple', 'SelectMultipleModel', 'SelectMultipleView',
                                      styles.DescriptionStyle, { rows: 5 }, true);
const SelectionRangeSlider = selectionClass('SelectionRangeSlider', 'SelectionRangeSliderModel',
                                            'SelectionRangeSliderView', styles.SliderStyle,
                                            Object.assign({ index: [0, 0] }, SELECTION_SLIDER), true);

const Box = widgetClass('Box', DOMWidget, { model: 'BoxModel', view: 'BoxView', style: null, defaults: BOX });
const HBox = widgetClass('HBox', Box, { model: 'HBoxModel', view: 'HBoxView', defaults: {} });
const VBox = widgetClass('VBox', Box, { model: 'VBoxModel', view: 'VBoxView', defaults: {} });
const GridBox = widgetClass('GridBox', Box, { model: 'GridBoxModel', view: 'GridBoxView', defaults: {} });

function containerClass(name, model, view) {
  const base = widgetClass(name, Box, { model, view, defaults: { titles: [], selected_index: null } });
  const cls = class extends base {
    _prepareState(state) {
      const prepared = super._prepareState(state);
      const children = prepared.children || [];
      const titles = Array.from(prepared.titles || [], String);
      while (titles.length < children.length) {
        titles.push('');
      }
      prepared.titles = titles;
      if (name === 'Tab' && prepared.selected_index === undefined && children.length > 0) {
        prepared.selected_index = 0;
      }
      return prepared;
    }
  };
  Object.defineProperty(cls, 'name', { value: name });
  return cls;
}

const Accordion = containerClass('Accordion', 'AccordionModel', 'AccordionView');
const Tab = containerClass('Tab', 'TabModel', 'TabView');
const Stack = containerClass('Stack', 'StackModel', 'StackView');

/**
 * Captures outputs. Use output.capture(callback) to show the outputs of a
 * function in the widget, or output.append(...) and output.clear().
 */
class Output extends widgetClass('Output', DOMWidget, {
  model: 'OutputModel', view: 'OutputView', module: OUTPUT_MODULE, moduleVersion: OUTPUT_MODULE_VERSION, style: null,
  defaults: { msg_id: '', outputs: [] }
}) {
  /** Returns a function which shows the outputs of callback in the widget. */
  capture(callback, options = {}) {
    if (typeof callback !== 'function') {
      return fn => this.capture(fn, callback);
    }
    const output = this;
    return function (...args) {
      if (options.clearOutput) {
        output.clear();
      }
      const previous = output.get('msg_id');
      // The frontend shows the outputs of the current message in the widget
      output.set('msg_id', parentMessageId());
      const restore = () => output.set('msg_id', previous);
      let result;
      try {
        result = callback.apply(this, args);
      } catch (error) {
        restore();
        throw error;
      }
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).finally(restore);
      }
      restore();
      return result;
    };
  }

  /** Removes the outputs of the widget. */
  clear() {
    this.set('outputs', []);
  }

  /** Adds text to the widget, on stdout or on stderr. */
  appendStdout(text) {
    this.set('outputs', [...this.get('outputs'), { output_type: 'stream', name: 'stdout', text: String(text) }]);
  }

  appendStderr(text) {
    this.set('outputs', [...this.get('outputs'), { output_type: 'stream', name: 'stderr', text: String(text) }]);
  }

  /** Adds a MIME bundle to the widget. */
  appendDisplayData(data, metadata = {}) {
    this.set('outputs', [...this.get('outputs'), { output_type: 'display_data', data, metadata }]);
  }
}

/** Links the properties of two widgets in the frontend: new Link({ source: [a, 'value'], target: [b, 'value'] }). */
const DirectionalLink = widgetClass('DirectionalLink', Widget, {
  model: 'DirectionalLinkModel', view: null, style: null, defaults: { source: null, target: null }
});
const Link = widgetClass('Link', DirectionalLink, { model: 'LinkModel', view: null, defaults: {} });

/** Links two widget properties in the frontend, in both directions: jslink([a, 'value'], [b, 'value']). */
function jslink(source, target) {
  return new Link({ source, target });
}

/** Links a widget property to another one in the frontend: jsdlink([a, 'value'], [b, 'value']). */
function jsdlink(source, target) {
  return new DirectionalLink({ source, target });
}

// The frontend asks for the state of all the widgets on this target when it
// is reloaded, to restore them in one message.
Comm.registerTarget('jupyter.widget.control', comm => {
  comm.onMsg = data => {
    if (data.method !== 'request_states') {
      return;
    }
    const states = {};
    const bufferPaths = [];
    const buffers = [];
    for (const [id, widget] of widgetsById) {
      const ctor = widget.constructor;
      const serialized = serializeState(widget._state);
      states[id] = {
        model_name: ctor.modelName,
        model_module: ctor.modelModule,
        model_module_version: ctor.modelModuleVersion,
        state: serialized.state
      };
      serialized.bufferPaths.forEach((path, i) => {
        bufferPaths.push([id, 'state', ...path]);
        buffers.push(serialized.buffers[i]);
      });
    }
    comm.send({ method: 'update_states', states, buffer_paths: bufferPaths }, {}, buffers);
  };
});

setDoc(Widget, 'Base class of the Jupyter widgets.\n\n' +
  'Properties are synchronized with the frontend. Listen to changes with\n' +
  'widget.observe(({ name, new: value, old }) => {}, names?) or widget.on("change:name", callback).');
setDoc(Button, 'A button.\n\nnew Button({ description, button_style?, icon?, tooltip? })\n' +
  'button.onClick(callback) calls the callback when the button is clicked.');
setDoc(Output, 'Captures outputs.\n\nconst out = new Output();\n' +
  'button.onClick(out.capture(() => console.log("clicked")));\n\nSee also out.clear() and out.appendStdout(text).');
setDoc(jslink, 'Links two widget properties in the frontend: jslink([slider, "value"], [text, "value"]).');
setDoc(jsdlink, 'Links a widget property to another one in the frontend: jsdlink([source, "value"], [target, "value"]).');

return Object.freeze(Object.assign({
  Widget, DOMWidget, Layout, Style,
  IntSlider, FloatSlider, FloatLogSlider, IntRangeSlider, FloatRangeSlider, Play,
  IntProgress, FloatProgress, IntText, FloatText, BoundedIntText, BoundedFloatText,
  Checkbox, ToggleButton, Valid,
  Dropdown, RadioButtons, Select, SelectMultiple, ToggleButtons, SelectionSlider, SelectionRangeSlider,
  Text, Textarea, Password, Combobox, Label, HTML, HTMLMath,
  Button, ColorPicker, Image, Output,
  Box, HBox, VBox, GridBox, Accordion, Tab, Stack,
  Link, DirectionalLink, jslink, jsdlink
}, styles));
})
