#pragma once

#include <pebble.h>
#include "message_keys.h"

typedef enum {
  STATE_IDLE,
  STATE_DICTATING,
  STATE_SENDING,
  STATE_WAITING,
  STATE_SHOWING,
  STATE_ERROR,
} AppState;

void state_init(void);
void state_deinit(void);

AppState state_current(void);
void state_set(AppState next);

int state_turn_count(void);
void state_increment_turn(void);
void state_reset_turns(void);

OwuiErrorCode state_last_error(void);
void state_set_error(OwuiErrorCode code);

const char *state_response_text(void);
void state_set_response(char *owned_text);  // takes ownership; freed on next set or deinit
