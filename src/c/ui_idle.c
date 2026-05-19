#include "ui_idle.h"
#include "state.h"
#include "dictation.h"
#include "transport.h"

#include <pebble.h>

static Window *s_window = NULL;
static TextLayer *s_body_layer = NULL;
static TextLayer *s_footer_layer = NULL;
static char s_body_buf[128];
static char s_footer_buf[64];

// When a long-click is recognized for a button, Pebble's recognizer can also
// fire the single_click handler on release. Set this flag in the long-click
// handler so the following single_click skips its action.
static bool s_back_long_just_fired = false;

static const char *error_text_for(OwuiErrorCode code) {
  switch (code) {
    case ERR_PHONE_DISCONNECTED:  return "Phone not connected";
    case ERR_NO_SPEECH:           return "Didn't hear anything";
    case ERR_RECOGNITION_FAILED:  return "Could not transcribe";
    case ERR_SERVER_UNREACHABLE:  return "Server unreachable";
    case ERR_BAD_API_KEY:         return "Bad API key";
    case ERR_ACCESS_DENIED:       return "Access denied";
    case ERR_SERVER_ERROR:        return "Server error";
    case ERR_TIMEOUT:             return "Timed out";
    case ERR_RESPONSE_TOO_LARGE:  return "Response too long";
    case ERR_OUT_OF_MEMORY:       return "Out of memory";
    case ERR_TRANSPORT_FAILED:    return "Lost connection";
    case ERR_BUSY:                return "Busy, try again";
    default:                      return "Unknown error";
  }
}

static void refresh_text(void) {
  if (state_current() == STATE_ERROR) {
    OwuiErrorCode code = state_last_error();
    int dict_status = state_dictation_status();
    if (dict_status != 0 &&
        (code == ERR_RECOGNITION_FAILED || code == ERR_NO_SPEECH ||
         code == ERR_PHONE_DISCONNECTED)) {
      // Show the raw dictation status code beside the message so users can
      // report which failure mode the platform is returning. e.g.
      //   "Could not transcribe (status 4)"
      snprintf(s_body_buf, sizeof(s_body_buf), "%s\n(status %d)",
               error_text_for(code), dict_status);
    } else {
      snprintf(s_body_buf, sizeof(s_body_buf), "%s", error_text_for(code));
    }
    snprintf(s_footer_buf, sizeof(s_footer_buf), "SELECT: retry  BACK: dismiss");
  } else {
    // Pebble's dictation modal is system-owned: it opens on SELECT and uses
    // tap-to-start / tap-to-stop in the modal itself. We can't make it
    // hold-to-talk, so the label matches what actually happens.
    snprintf(s_body_buf, sizeof(s_body_buf), "Press SELECT to talk");
    snprintf(s_footer_buf, sizeof(s_footer_buf), "Long BACK = new chat");
  }
  // Layers may not exist yet on the first call (window_load runs after the
  // initial state_init → ui_idle_show path). Window_load reads the populated
  // buffer when it creates the layers, so no redraw is needed in that case.
  if (s_body_layer)   layer_mark_dirty(text_layer_get_layer(s_body_layer));
  if (s_footer_layer) layer_mark_dirty(text_layer_get_layer(s_footer_layer));
}

static void on_select(ClickRecognizerRef rec, void *ctx) {
  if (state_current() == STATE_ERROR) {
    state_set(STATE_IDLE);
    refresh_text();
  } else if (state_current() == STATE_IDLE) {
    state_set(STATE_DICTATING);
    dictation_start();
  }
}

static void on_back(ClickRecognizerRef rec, void *ctx) {
  if (s_back_long_just_fired) {
    s_back_long_just_fired = false;
    return;  // suppress the trailing single_click after a long-click
  }
  if (state_current() == STATE_ERROR) {
    state_set(STATE_IDLE);
    refresh_text();
  } else {
    window_stack_pop_all(true);  // exits the app
  }
}

static void on_back_long(ClickRecognizerRef rec, void *ctx) {
  s_back_long_just_fired = true;
  transport_send_reset();
  state_reset_turns();
#ifdef OWUI_DEBUG_FAKE_DICTATION
  dictation_debug_reset();
#endif
  refresh_text();
}

// Empty up-handler. SOME Pebble SDK builds require it to be non-NULL for
// long_click_subscribe to dispatch the down handler at all. The release
// after a recognized long-press is intentionally a no-op — on_back clears
// the suppression flag on the trailing single-click instead.
static void on_back_long_up(ClickRecognizerRef rec, void *ctx) { }

static void click_config_provider(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_SELECT, on_select);
  window_single_click_subscribe(BUTTON_ID_BACK, on_back);
  window_long_click_subscribe(BUTTON_ID_BACK, 700, on_back_long, on_back_long_up);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  // Vertically center the call-to-action between the top of the screen and
  // the footer. GOTHIC_28_BOLD = ~30px line height; two-line cap allows for
  // word wrap of "Hold SELECT to speak" if a future variant is longer.
  const int16_t footer_h = 20;
  const int16_t body_h = 70;
  int16_t body_y = (bounds.size.h - footer_h - body_h) / 2;
  if (body_y < 0) body_y = 0;
  s_body_layer = text_layer_create(GRect(0, body_y, bounds.size.w, body_h));
  text_layer_set_text(s_body_layer, s_body_buf);
  text_layer_set_text_alignment(s_body_layer, GTextAlignmentCenter);
  text_layer_set_font(s_body_layer, fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
  text_layer_set_overflow_mode(s_body_layer, GTextOverflowModeWordWrap);
  layer_add_child(root, text_layer_get_layer(s_body_layer));

  s_footer_layer = text_layer_create(GRect(0, bounds.size.h - 22, bounds.size.w, footer_h));
  text_layer_set_text(s_footer_layer, s_footer_buf);
  text_layer_set_text_alignment(s_footer_layer, GTextAlignmentCenter);
  text_layer_set_font(s_footer_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
  layer_add_child(root, text_layer_get_layer(s_footer_layer));
}

static void window_unload(Window *window) {
  if (s_body_layer) text_layer_destroy(s_body_layer);
  if (s_footer_layer) text_layer_destroy(s_footer_layer);
  s_body_layer = NULL;
  s_footer_layer = NULL;
}

void ui_idle_init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
  s_body_buf[0] = '\0';
  s_footer_buf[0] = '\0';
}

void ui_idle_deinit(void) {
  if (s_window) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

void ui_idle_show(void) {
  refresh_text();  // populates buffers; window_load reads them when it fires
  if (!window_stack_contains_window(s_window)) {
    window_stack_push(s_window, true);
  }
}
