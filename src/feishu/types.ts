/**
 * Shared Feishu event / transport types used across the gateway and
 * the message translator.
 */

/**
 * Payload of the `im.message.receive_v1` event, narrowed to the fields
 * our translator actually consumes. The upstream event carries more
 * fields (chat_type, mentions, parent_id, ...) — add them here as we
 * start reading them.
 */
export interface ReceiveV1Event {
  sender: {
    sender_id: {
      open_id: string;
    };
  };
  message: {
    message_id: string;
    chat_id: string;
    message_type: string;
    content: string; // JSON-encoded
    create_time: string;
  };
}
