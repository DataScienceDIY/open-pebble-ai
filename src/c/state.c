#include "state.h"
#include "ui_idle.h"
#include "ui_spinner.h"
#include "ui_response.h"

#include <string.h>
#include <stdlib.h>

static AppState s_state = STATE_IDLE;
static int s_turn = 0;
static OwuiErrorCode s_last_error = ERR_NONE;
static char *s_response = NULL;
static char *s_user_text = NULL;
static FontChoice s_font = FONT_MEDIUM;
static int s_dictation_status = 0;

static void update_ui_for_state(AppState s) {
  // Each state owns one window. Pop the others to keep the window stack
  // linear, so going SHOWING→DICTATING→SENDING surfaces the spinner instead
  // of leaving the response window on top.
  switch (s) {
    case STATE_IDLE:
    case STATE_ERROR:
      ui_response_hide();
      ui_spinner_hide();
      ui_idle_show();
      break;
    case STATE_DICTATING:
      // Dictation API owns the screen during this state.
      break;
    case STATE_SENDING:
      ui_response_hide();
      ui_spinner_show("Sending...");
      break;
    case STATE_WAITING:
      ui_response_hide();
      ui_spinner_show("Thinking...");
      break;
    case STATE_SHOWING:
      ui_spinner_hide();
      ui_response_show(s_response ? s_response : "");
      break;
  }
}

void state_init(void) {
  s_state = STATE_IDLE;
  s_turn = 0;
  s_last_error = ERR_NONE;
  s_response = NULL;
  update_ui_for_state(s_state);
}

void state_deinit(void) {
  if (s_response) {
    free(s_response);
    s_response = NULL;
  }
  if (s_user_text) {
    free(s_user_text);
    s_user_text = NULL;
  }
}

AppState state_current(void) { return s_state; }

static const char *state_name(AppState s) {
  switch (s) {
    case STATE_IDLE:      return "IDLE";
    case STATE_DICTATING: return "DICTATING";
    case STATE_SENDING:   return "SENDING";
    case STATE_WAITING:   return "WAITING";
    case STATE_SHOWING:   return "SHOWING";
    case STATE_ERROR:     return "ERROR";
    default:              return "?";
  }
}

void state_set(AppState next) {
  // STATE: <prev>-><next>  is the grep marker for the harness.
  APP_LOG(APP_LOG_LEVEL_INFO, "STATE: %s->%s", state_name(s_state), state_name(next));
  s_state = next;
  update_ui_for_state(next);
}

int state_turn_count(void) { return s_turn; }
void state_increment_turn(void) { s_turn++; }
void state_reset_turns(void) { s_turn = 0; }

OwuiErrorCode state_last_error(void) { return s_last_error; }
void state_set_error(OwuiErrorCode code) {
  s_last_error = code;
  state_set(STATE_ERROR);
}

const char *state_response_text(void) { return s_response; }
void state_set_response(char *owned_text) {
  if (s_response) free(s_response);
  s_response = owned_text;
}

const char *state_user_text(void) { return s_user_text ? s_user_text : ""; }
void state_set_user_text(const char *text) {
  if (s_user_text) {
    free(s_user_text);
    s_user_text = NULL;
  }
  if (!text) return;
  size_t n = strlen(text);
  s_user_text = malloc(n + 1);
  if (s_user_text) {
    memcpy(s_user_text, text, n);
    s_user_text[n] = '\0';
  }
}

FontChoice state_font(void) { return s_font; }
void state_set_font(FontChoice f) { s_font = f; }

int  state_dictation_status(void) { return s_dictation_status; }
void state_set_dictation_status(int status) { s_dictation_status = status; }
const char *state_font_key(void) {
  return s_font == FONT_LARGE ? FONT_KEY_GOTHIC_28 : FONT_KEY_GOTHIC_24;
}
