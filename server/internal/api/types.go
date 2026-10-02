package api

import "time"

type User struct {
	ProfileVersion int64     `json:"profile_version"`
	ID             string    `json:"id"`
	WorkOSID       *string   `json:"-"`
	Email          string    `json:"email"`
	Name           string    `json:"name"`
	Username       *string   `json:"username"`
	Bio            string    `json:"bio"`
	PresenceStatus string    `json:"presence_status,omitempty"`
	AvatarURL      *string   `json:"avatar_url"`
	CreatedAt      time.Time `json:"created_at"`
}
type Room struct {
	SlowModeSeconds int       `json:"slow_mode_seconds"`
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	DisplayName     *string   `json:"display_name,omitempty"`
	OwnerID         string    `json:"owner_id"`
	Role            string    `json:"role"`
	Kind            string    `json:"kind"`
	CreatedAt       time.Time `json:"created_at"`
	ActivityAt      time.Time `json:"activity_at"`
}
type Message struct {
	ID                string              `json:"id"`
	RoomID            string              `json:"room_id"`
	Author            User                `json:"author"`
	Body              string              `json:"body"`
	CreatedAt         time.Time           `json:"created_at"`
	Sequence          int64               `json:"sequence"`
	Version           int64               `json:"version"`
	EditedAt          *time.Time          `json:"edited_at,omitempty"`
	DeletedAt         *time.Time          `json:"deleted_at,omitempty"`
	Reply             *MessageReply       `json:"reply,omitempty"`
	Mentions          []MessageMention    `json:"mentions"`
	Reactions         []MessageReaction   `json:"reactions"`
	Attachments       []MessageAttachment `json:"attachments"`
	ThreadRootID      *string             `json:"thread_root_id,omitempty"`
	ThreadReplyCount  int64               `json:"thread_reply_count,omitempty"`
	ThreadUnreadCount int64               `json:"thread_unread_count,omitempty"`
	PinnedAt          *time.Time          `json:"pinned_at,omitempty"`
	PinnedBy          *string             `json:"pinned_by,omitempty"`
}

type MessageAttachment struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	SizeBytes   int64  `json:"size_bytes"`
}

type MessageReply struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Body    string `json:"body"`
	Deleted bool   `json:"deleted"`
}
type MessageMention struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type MessageReaction struct {
	Emoji string   `json:"emoji"`
	Users []string `json:"users"`
}
type MessagePage struct {
	Messages     []Message `json:"messages"`
	BeforeID     string    `json:"before_id,omitempty"`
	ReadSequence int64     `json:"read_sequence"`
	Root         *Message  `json:"root,omitempty"`
}
type RoomUnread struct {
	RoomID       string `json:"room_id"`
	Unread       int64  `json:"unread"`
	Mentions     int64  `json:"mentions"`
	ReadSequence int64  `json:"read_sequence"`
}
type FriendRequest struct {
	ID        string    `json:"id"`
	Sender    User      `json:"sender"`
	Receiver  User      `json:"receiver"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}
type RoomMember struct {
	RestrictedUntil *time.Time `json:"restricted_until,omitempty"`
	User            User       `json:"user"`
	Role            string     `json:"role"`
	JoinedAt        time.Time  `json:"joined_at"`
}

type Store interface {
	UpsertUser(workosID, email, name string, avatar *string) (User, error)
	UpsertDevUser(email, name string) (User, error)
	UserByID(id string) (User, error)
	FindUsers(query, userID string) ([]User, error)
	ListRooms(userID string) ([]Room, error)
	CreateRoom(userID, name string) (Room, error)
	CreateDirectRoom(userID, friendID string) (Room, error)
	RoomForMember(roomID, userID string) (Room, error)
	RenameRoom(roomID, ownerID, name string) (Room, error)
	DeleteRoom(roomID, ownerID string) error
	RemoveRoomMember(roomID, actorID, userID string) error
	ListRoomMembers(roomID string) ([]RoomMember, error)
	AddRoomMember(roomID, ownerID, newUserID string) error
	ListMessages(roomID string, before time.Time, limit int) ([]Message, error)
	CreateMessage(roomID, userID, body string) (Message, error)
	ListFriends(userID string) ([]User, []FriendRequest, error)
	CreateFriendRequest(senderID, receiverID string) (FriendRequest, error)
	AcceptFriendRequest(requestID, receiverID string) error
	DeleteFriendship(userID, otherID string) (string, error)
}
