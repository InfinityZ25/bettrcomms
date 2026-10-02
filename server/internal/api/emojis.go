package api

import (
	"context"
	_ "embed"
	"errors"
	"github.com/jackc/pgx/v5"
	"strings"
)

// Unicode 17.0 qualified emoji, generated with scripts/update-emoji-data.mjs.
// The local client catalog and server allowlist use the same source release.
//
//go:embed emoji_sequences.txt
var emojiSequences string

var reactionChoices = func() map[string]bool {
	choices := make(map[string]bool)
	for _, emoji := range strings.Fields(emojiSequences) {
		choices[emoji] = true
	}
	return choices
}()

var ErrReactionLimit = errors.New("reaction limit reached")

// The caller holds the message row lock, so simultaneous additions cannot
// exceed the cap. Repeating an existing reaction is still idempotent.
func checkReactionCapacity(ctx context.Context, tx pgx.Tx, message, user, emoji string) error {
	var own, present bool
	var distinct, userCount int
	err := tx.QueryRow(ctx, `SELECT COALESCE(bool_or(user_id=$2 AND emoji=$3),false),count(DISTINCT emoji),count(*) FILTER(WHERE user_id=$2),COALESCE(bool_or(emoji=$3),false) FROM message_reactions WHERE message_id=$1`, message, user, emoji).Scan(&own, &distinct, &userCount, &present)
	if err != nil {
		return err
	}
	if !own && (userCount >= 10 || distinct >= 20 && !present) {
		return ErrReactionLimit
	}
	return nil
}
