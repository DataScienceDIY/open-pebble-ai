#include "ui_response.h"
#include "state.h"
#include "dictation.h"
#include "transport.h"

#include <pebble.h>

static Window *s_window = NULL;
static ScrollLayer *s_scroll_layer = NULL;
static TextLayer *s_text_layer = NULL;
static const char *s_pending_text = "";  // shown by window_load when layers come up

#define MAX_RESPONSE_HEIGHT 4000

static void apply_text(void) {
  if (!s_text_layer || !s_scroll_layer) return;
  text_layer_set_text(s_text_layer, s_pending_text);
  GSize used = text_layer_get_content_size(s_text_layer);
  text_layer_set_size(s_text_layer, GSize(used.w + 4, used.h + 8));
  scroll_layer_set_content_size(s_scroll_layer, GSize(used.w + 4, used.h + 8));
  scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, 0), false);
}

static void on_select(ClickRecognizerRef rec, void *ctx) {
  // Start a follow-up turn.
  state_set(STATE_DICTATING);
  dictation_start();
}

static void on_back(ClickRecognizerRef rec, void *ctx) {
  state_set(STATE_IDLE);
}

static void on_back_long(ClickRecognizerRef rec, void *ctx) {
  transport_send_reset();
  state_reset_turns();
  state_set(STATE_IDLE);
}

static void click_config_provider(void *ctx) {
  // Scroll layer's own click config handles UP/DOWN; we add SELECT and BACK.
  scroll_layer_set_click_config_onto_window(s_scroll_layer, s_window);
  window_single_click_subscribe(BUTTON_ID_SELECT, on_select);
  window_single_click_subscribe(BUTTON_ID_BACK, on_back);
  window_long_click_subscribe(BUTTON_ID_BACK, 700, on_back_long, NULL);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_scroll_layer = scroll_layer_create(bounds);
  s_text_layer = text_layer_create(GRect(4, 0, bounds.size.w - 8, MAX_RESPONSE_HEIGHT));
  text_layer_set_text(s_text_layer, "");
  text_layer_set_font(s_text_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_overflow_mode(s_text_layer, GTextOverflowModeWordWrap);

  scroll_layer_add_child(s_scroll_layer, text_layer_get_layer(s_text_layer));
  layer_add_child(root, scroll_layer_get_layer(s_scroll_layer));

  apply_text();
}

static void window_unload(Window *window) {
  if (s_text_layer) text_layer_destroy(s_text_layer);
  if (s_scroll_layer) scroll_layer_destroy(s_scroll_layer);
  s_text_layer = NULL;
  s_scroll_layer = NULL;
}

void ui_response_init(void) {
  s_window = window_create();
  window_set_click_config_provider(s_window, click_config_provider);
  window_set_window_handlers(s_window, (WindowHandlers){
    .load = window_load,
    .unload = window_unload,
  });
}

void ui_response_deinit(void) {
  if (s_window) {
    window_destroy(s_window);
    s_window = NULL;
  }
}

void ui_response_show(const char *text) {
  s_pending_text = text ? text : "";
  if (!window_stack_contains_window(s_window)) {
    window_stack_push(s_window, true);  // window_load will apply_text()
  } else {
    apply_text();
  }
}
