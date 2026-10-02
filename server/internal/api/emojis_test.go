package api

import "testing"

func TestQualifiedEmojiCatalog(t *testing.T) {
	if len(reactionChoices) != 3944 {
		t.Fatalf("incomplete catalog: %d", len(reactionChoices))
	}
	for _, emoji := range []string{"👍🏽", "👩‍💻", "🇲🇽", "1️⃣", "❤️"} {
		if !reactionChoices[emoji] {
			t.Errorf("missing qualified emoji %q", emoji)
		}
	}
	for _, value := range []string{"hello", "😀😀", "<img>", "\U0001F3FD", ""} {
		if reactionChoices[value] {
			t.Errorf("invalid reaction accepted %q", value)
		}
	}
}
