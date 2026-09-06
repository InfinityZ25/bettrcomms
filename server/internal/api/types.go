package api

import "time"

type User struct {
	ID        string    `json:"id"`
	WorkOSID  *string   `json:"-"`
	Email     string    `json:"email"`
	Name      string    `json:"name"`
	AvatarURL *string   `json:"avatar_url"`
	CreatedAt time.Time `json:"created_at"`
}
type Room struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"owner_id"`
	Role      string    `json:"role"`
	Kind      string    `json:"kind"`
	CreatedAt time.Time `json:"created_at"`
}
type Message struct {
	ID        string    `json:"id"`
	RoomID    string    `json:"room_id"`
	Author    User      `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"created_at"`
}
type FriendRequest struct {
	ID        string    `json:"id"`
	Sender    User      `json:"sender"`
	Receiver  User      `json:"receiver"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
}
type RoomMember struct {
	User     User      `json:"user"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
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
	DeleteFriendship(userID, otherID string) error
}
