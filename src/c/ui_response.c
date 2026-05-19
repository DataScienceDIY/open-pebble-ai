#include "ui_response.h"
#include "state.h"
#include "dictation.h"
#include "transport.h"

#include <pebble.h>
#include <string.h>

// Chat-bubble response window.
// Layout: two stacked bubbles inside a ScrollLayer — the user's dictated text
// on top (one accent color) and the AI's response below (another accent
// color). Each bubble is a custom Layer that draws a rounded rect border, with
// a TextLayer child for the word-wrapped content.

static Window *s_window = NULL;
static ScrollLayer *s_scroll_layer = NULL;
static bool s_back_long_just_fired = false;

typedef struct {
  Layer *border;
  TextLayer *text;
  GColor border_color;
} Bubble;

static Bubble s_user_bubble;
static Bubble s_ai_bubble;

#define BUBBLE_RADIUS       6
#define BUBBLE_BORDER       2
#define BUBBLE_PAD_X        8
// Asymmetric Y padding: TextLayer's content_size measures ascender-to-baseline
// area but the font draws a noticeable gap above ascenders. Compensate by
// shifting the text upward, and add explicit descender slack at the bottom so
// glyphs like "y", "g", "p" aren't clipped.
#define BUBBLE_PAD_TOP      0
#define BUBBLE_PAD_BOTTOM   2
#define BUBBLE_TEXT_Y_TRIM  6     // shift text upward to absorb the ascent gap
#define BUBBLE_DESCENDER    6     // extra height added to the text frame for descenders
#define BUBBLE_GAP_Y        6     // vertical gap between user and AI bubbles
#define BUBBLE_MARGIN_X     4     // left/right margin inside the scroll layer
#define BUBBLE_TOP_MARGIN   4
#define BUBBLE_BOTTOM_PAD   6
#define MAX_TEXT_HEIGHT     2000  // upper bound for content size measurement

static void draw_bubble(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  Bubble *bubble =
      (layer == s_user_bubble.border) ? &s_user_bubble : &s_ai_bubble;
  graphics_context_set_stroke_color(ctx, bubble->border_color);
  graphics_context_set_stroke_width(ctx, BUBBLE_BORDER);
  graphics_draw_round_rect(ctx, GRect(0, 0, b.size.w, b.size.h), BUBBLE_RADIUS);
}

static void init_bubble(Bubble *bubble, GColor border_color, GFont font) {
  bubble->border_color = border_color;
  bubble->border = layer_create(GRect(0, 0, 1, 1));  // resized in apply_text
  layer_set_update_proc(bubble->border, draw_bubble);

  bubble->text = text_layer_create(GRect(0, 0, 1, 1));
  text_layer_set_text(bubble->text, "");
  text_layer_set_font(bubble->text, font);
  text_layer_set_background_color(bubble->text, GColorClear);
  text_layer_set_text_color(bubble->text, GColorBlack);
  text_layer_set_overflow_mode(bubble->text, GTextOverflowModeWordWrap);

  layer_add_child(bubble->border, text_layer_get_layer(bubble->text));
}

static void destroy_bubble(Bubble *bubble) {
  if (bubble->text)   text_layer_destroy(bubble->text);
  if (bubble->border) layer_destroy(bubble->border);
  bubble->text = NULL;
  bubble->border = NULL;
}

// Sizes a bubble to fit `text` within `max_width`, places it at `align_right`
// (user style) or left (AI style) within the scroll layer of width
// `scroll_w`, and returns its total height.
static int16_t layout_bubble(Bubble *bubble, const char *text,
                             int16_t y, int16_t scroll_w, bool align_right) {
  text_layer_set_text(bubble->text, text ? text : "");
  int16_t max_width = scroll_w - 2 * BUBBLE_MARGIN_X;
  int16_t inner_w_max = max_width - 2 * (BUBBLE_PAD_X + BUBBLE_BORDER);
  // Probe with a tall layout to get the wrapped content size.
  text_layer_set_size(bubble->text, GSize(inner_w_max, MAX_TEXT_HEIGHT));
  GSize used = text_layer_get_content_size(bubble->text);
  int16_t inner_w = used.w;
  int16_t inner_h = used.h + BUBBLE_DESCENDER;  // give descenders room
  int16_t border_w = inner_w + 2 * (BUBBLE_PAD_X + BUBBLE_BORDER);
  if (border_w > max_width) border_w = max_width;
  int16_t border_h = inner_h - BUBBLE_TEXT_Y_TRIM
                     + BUBBLE_PAD_TOP + BUBBLE_PAD_BOTTOM
                     + 2 * BUBBLE_BORDER;
  int16_t x = align_right ? (scroll_w - BUBBLE_MARGIN_X - border_w)
                          : BUBBLE_MARGIN_X;

  layer_set_frame(bubble->border, GRect(x, y, border_w, border_h));
  text_layer_set_size(
      bubble->text,
      GSize(border_w - 2 * (BUBBLE_PAD_X + BUBBLE_BORDER), inner_h));
  // Within the bubble, align user text right and AI text left for a chat-style
  // visual cue beyond just the border color.
  text_layer_set_text_alignment(
      bubble->text, align_right ? GTextAlignmentRight : GTextAlignmentLeft);
  layer_set_frame(
      text_layer_get_layer(bubble->text),
      GRect(BUBBLE_PAD_X + BUBBLE_BORDER,
            BUBBLE_PAD_TOP + BUBBLE_BORDER - BUBBLE_TEXT_Y_TRIM,
            border_w - 2 * (BUBBLE_PAD_X + BUBBLE_BORDER), inner_h));
  return border_h;
}

static void apply_text(void) {
  if (!s_scroll_layer) return;

  // Re-apply current font choice on every render (config may have changed
  // mid-session via webviewclosed → FontSize push).
  GFont font = fonts_get_system_font(state_font_key());
  text_layer_set_font(s_user_bubble.text, font);
  text_layer_set_font(s_ai_bubble.text, font);

  GRect scroll_bounds = layer_get_bounds(scroll_layer_get_layer(s_scroll_layer));
  int16_t scroll_w = scroll_bounds.size.w;

  int16_t y = BUBBLE_TOP_MARGIN;
  const char *user_text = state_user_text();
  if (user_text && user_text[0]) {
    y += layout_bubble(&s_user_bubble, user_text, y, scroll_w, true /*right*/);
    y += BUBBLE_GAP_Y;
  } else {
    // Hide the user bubble by collapsing it to zero size.
    layer_set_frame(s_user_bubble.border, GRect(0, 0, 0, 0));
  }

  const char *ai_text = state_response_text();
  y += layout_bubble(&s_ai_bubble, ai_text ? ai_text : "",
                     y, scroll_w, false /*left*/);
  y += BUBBLE_BOTTOM_PAD;

  scroll_layer_set_content_size(s_scroll_layer, GSize(scroll_w, y));
  scroll_layer_set_content_offset(s_scroll_layer, GPoint(0, 0), false);
}

static void on_select(ClickRecognizerRef rec, void *ctx) {
  // Follow-up turn.
  state_set(STATE_DICTATING);
  dictation_start();
}

static void on_back(ClickRecognizerRef rec, void *ctx) {
  if (s_back_long_just_fired) {
    s_back_long_just_fired = false;
    return;  // suppress the trailing single_click after a long-click
  }
  state_set(STATE_IDLE);
}

static void on_back_long(ClickRecognizerRef rec, void *ctx) {
  s_back_long_just_fired = true;
  transport_send_reset();
  state_reset_turns();
  state_set(STATE_IDLE);
}

static void on_back_long_up(ClickRecognizerRef rec, void *ctx) { }

// Adds SELECT and BACK on top of the scroll layer's UP/DOWN config.
// Set via window_set_click_config_provider() *after* the scroll layer is
// wired into the window in window_load.
static void click_config_provider(void *ctx) {
  window_single_click_subscribe(BUTTON_ID_SELECT, on_select);
  window_single_click_subscribe(BUTTON_ID_BACK, on_back);
  window_long_click_subscribe(BUTTON_ID_BACK, 700, on_back_long, on_back_long_up);
}

static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_scroll_layer = scroll_layer_create(bounds);

  // Font selection lives in PKJS config; transport pushes it down via the
  // FontSize key. Until that arrives we use the default (medium).
  GFont font = fonts_get_system_font(state_font_key());
  // emery has color; pick contrasting bubble borders.
  init_bubble(&s_user_bubble,
              PBL_IF_COLOR_ELSE(GColorVividCerulean, GColorBlack), font);  // blue = user
  init_bubble(&s_ai_bubble,
              PBL_IF_COLOR_ELSE(GColorOrange, GColorBlack), font);          // orange = AI

  scroll_layer_add_child(s_scroll_layer, s_user_bubble.border);
  scroll_layer_add_child(s_scroll_layer, s_ai_bubble.border);
  layer_add_child(root, scroll_layer_get_layer(s_scroll_layer));

  // Order matters: textbook pattern (call
  // scroll_layer_set_click_config_onto_window from inside our
  // click_config_provider) crashes the emery firmware in this SDK. Setting
  // the scroll layer's click config directly, then layering our SELECT/BACK
  // provider on top, avoids the re-entrant click setup that triggers the bug.
  scroll_layer_set_click_config_onto_window(s_scroll_layer, s_window);
  window_set_click_config_provider(s_window, click_config_provider);

  apply_text();
}

static void window_unload(Window *window) {
  destroy_bubble(&s_user_bubble);
  destroy_bubble(&s_ai_bubble);
  if (s_scroll_layer) scroll_layer_destroy(s_scroll_layer);
  s_scroll_layer = NULL;
}

void ui_response_init(void) {
  s_window = window_create();
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
  // text is unused; both AI response and user text are read from state at
  // layout time (state_response_text(), state_user_text()).
  (void)text;
  if (!window_stack_contains_window(s_window)) {
    window_stack_push(s_window, true);  // window_load will apply_text()
  } else {
    apply_text();  // already on stack — re-layout for a follow-up turn
  }
}

void ui_response_hide(void) {
  if (window_stack_contains_window(s_window)) {
    window_stack_remove(s_window, false);
  }
}
