#include "state.h"
#include "ui_idle.h"
#include "ui_spinner.h"
#include "ui_response.h"

static AppState s_state = STATE_IDLE;
static int s_turn = 0;
static OwuiErrorCode s_last_error = ERR_NONE;
static char *s_response = NULL;

static void update_ui_for_state(AppState s) {
  switch (s) {
    case STATE_IDLE:
    case STATE_ERROR:
      ui_idle_show();
      break;
    case STATE_DICTATING:
      // Dictation API owns the screen during this state.
      break;
    case STATE_SENDING:
      ui_spinner_show("Sending...");
      break;
    case STATE_WAITING:
      ui_spinner_show("Thinking...");
      break;
    case STATE_SHOWING:
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
}

AppState state_current(void) { return s_state; }

void state_set(AppState next) {
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
