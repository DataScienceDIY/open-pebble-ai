#include <pebble.h>

#include "state.h"
#include "dictation.h"
#include "transport.h"
#include "ui_idle.h"
#include "ui_spinner.h"
#include "ui_response.h"
#include "message_keys.h"

static OwuiErrorCode dictation_status_to_error(int status) {
  switch (status) {
    case DictationSessionStatusFailureConnectivityError: return ERR_PHONE_DISCONNECTED;
    case DictationSessionStatusFailureRecognizerError:   return ERR_RECOGNITION_FAILED;
    case DictationSessionStatusFailureTranscriptionRejected:
    case DictationSessionStatusFailureTranscriptionRejectedWithError:
                                                          return ERR_NO_SPEECH;
    default:                                              return ERR_RECOGNITION_FAILED;
  }
}

static void on_dictation_done(const char *utterance) {
  state_set_user_text(utterance);  // snapshot for the response window
  state_set(STATE_SENDING);
  transport_send_utterance(utterance);
  state_set(STATE_WAITING);
}

static void on_dictation_fail(int status) {
  if (status == DictationSessionStatusFailureSystemAborted) {
    // User pressed cancel in the dictation modal; silent return to IDLE.
    state_set(STATE_IDLE);
    return;
  }
  state_set_error(dictation_status_to_error(status));
}

static void on_response(char *owned_response) {
  state_set_response(owned_response);
  state_increment_turn();
  state_set(STATE_SHOWING);
}

static void on_transport_error(OwuiErrorCode code) {
  state_set_error(code);
}

static void init(void) {
  ui_idle_init();
  ui_spinner_init();
  ui_response_init();

  dictation_init(on_dictation_done, on_dictation_fail);
  transport_init(on_response, on_transport_error);
  state_init();
}

static void deinit(void) {
  state_deinit();
  transport_deinit();
  dictation_deinit();
  ui_response_deinit();
  ui_spinner_deinit();
  ui_idle_deinit();
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
