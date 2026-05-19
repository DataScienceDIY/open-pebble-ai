#pragma once

// Wraps the dictation API.
// The transcription buffer passed to the dictation callback is freed after the
// callback returns. To avoid use-after-free, every utterance lives in a single
// static buffer owned by this module; callers use it before the next
// dictation_start() call invalidates it.

#include <pebble.h>

typedef void (*DictationDoneHandler)(const char *utterance);
typedef void (*DictationFailHandler)(int dictation_status);

void dictation_init(DictationDoneHandler on_done, DictationFailHandler on_fail);
void dictation_deinit(void);

void dictation_start(void);

#ifdef OWUI_DEBUG_FAKE_DICTATION
// Resets the cycling-utterance index so the next call replays "turn 1". Hooked
// to ResetConversation/long-BACK so the harness can run repeated scenarios.
void dictation_debug_reset(void);
#endif
