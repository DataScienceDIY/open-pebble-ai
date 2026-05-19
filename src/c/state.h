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

OwuiErrorCode state_last_error(void);
void state_set_error(OwuiErrorCode code);

// Optional context the error screen can surface — the raw Pebble dictation
// status code that triggered ERR_RECOGNITION_FAILED / ERR_NO_SPEECH /
// ERR_PHONE_DISCONNECTED. 0 = no specific status available.
int state_dictation_status(void);
void state_set_dictation_status(int status);

// Conversation history. Each Turn is one user utterance + AI response pair.
// The ring is FIFO-capped at MAX_TURNS; appending past that evicts the
// oldest. ui_response.c reads from this ring to render the chat-bubble
// scroll view.
#define MAX_TURNS 8

typedef struct {
  char *user;  // owned, malloc'd; never NULL after a committed turn
  char *ai;    // owned, malloc'd; never NULL after a committed turn
} Turn;

int         state_turn_count(void);
const Turn *state_turn_at(int idx);  // 0 = oldest of the visible window

// User text is staged in on_dictation_done before the AI response arrives;
// state_commit_turn moves it + the response into the ring as one Turn.
void        state_set_pending_user_text(const char *text);
const char *state_pending_user_text(void);
void        state_commit_turn(char *owned_ai_text);  // takes ownership of ai_text
void        state_clear_turns(void);

// Font size for the chat-bubble text, pushed from PKJS config via the
// FontSize AppMessage key. Default = 24 (medium); 28 is the large option.
typedef enum {
  FONT_MEDIUM = 0,
  FONT_LARGE  = 1,
} FontChoice;

FontChoice state_font(void);
void state_set_font(FontChoice f);
const char *state_font_key(void);  // returns FONT_KEY_GOTHIC_24 or _28
