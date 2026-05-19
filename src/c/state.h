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

// Latest user utterance for the response window's chat-bubble layout.
// Stored as a copy; safe to read after the dictation buffer is invalidated.
const char *state_user_text(void);
void state_set_user_text(const char *text);

// Font size for the chat-bubble text, pushed from PKJS config via the
// FontSize AppMessage key. Default = 24 (medium); 28 is the large option.
typedef enum {
  FONT_MEDIUM = 0,
  FONT_LARGE  = 1,
} FontChoice;

FontChoice state_font(void);
void state_set_font(FontChoice f);
const char *state_font_key(void);  // returns FONT_KEY_GOTHIC_24 or _28
