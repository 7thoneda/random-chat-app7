import { Server, Socket } from "socket.io";
import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import cors from 'cors'; 

// Load environment variables first
dotenv.config();

const app = express();
const server = http.createServer(app);

// Enhanced CORS configuration
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));

const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    transports: ['websocket', 'polling'],
    allowEIO3: true
});

interface User {
    socketId: string;
    isPremium?: boolean;
    genderFilter?: string;
    voiceOnly?: boolean;
    joinTime?: number;
}

let waitingUsers: User[] = [];
const userPairs: Record<string, string> = {};
const userProfiles: Record<string, User> = {};

const matchUser = (socket: Socket, userProfile: User) => {
    if(!socket.id) return;

    // Premium users get priority - sort waiting users by premium status
    waitingUsers.sort((a, b) => {
        if (a.isPremium && !b.isPremium) return -1;
        if (!a.isPremium && b.isPremium) return 1;
        return 0;
    });

    const compatibleUserIndex = waitingUsers.findIndex(waitingUser => {
        // Basic compatibility check
        if (!userProfile.genderFilter || userProfile.genderFilter === "any") {
            if (!waitingUser.genderFilter || waitingUser.genderFilter === "any") {
                return true;
            }
        }
        return true;
    });

    if (compatibleUserIndex !== -1) {
        const waitingUser = waitingUsers[compatibleUserIndex];

        waitingUsers.splice(compatibleUserIndex, 1);

        userPairs[socket.id] = waitingUser.socketId;
        userPairs[waitingUser.socketId] = socket.id;

        socket.emit("user:connect", waitingUser.socketId);

        console.log(`Matched ${socket.id} (Premium: ${userProfile.isPremium}) with ${waitingUser.socketId} (Premium: ${waitingUser.isPremium})`);
    } else {
        waitingUsers.push(userProfile);
        console.log(`${socket.id} (Premium: ${userProfile.isPremium}) is waiting for pair`);
    }
}

io.on('connection', (socket: Socket) => {
    console.log(`Socket connected ${socket.id}`);

    socket.on("user:profile", (profile: { isPremium?: boolean; genderFilter?: string; voiceOnly?: boolean }) => {
        const userProfile: User = {
            socketId: socket.id,
            isPremium: profile.isPremium || false,
            genderFilter: profile.genderFilter || "any",
            voiceOnly: profile.voiceOnly || false,
            joinTime: Date.now()
        };

        userProfiles[socket.id] = userProfile;
        matchUser(socket, userProfile);
    });

    const defaultProfile: User = {
        socketId: socket.id,
        isPremium: false,
        genderFilter: "any",
        voiceOnly: false,
        joinTime: Date.now()
    };
    userProfiles[socket.id] = defaultProfile;
    matchUser(socket, defaultProfile);

    socket.on("offer", ({offer, to}: {offer: RTCSessionDescriptionInit, to: string}) => {
        io.to(to).emit("offer", {offer, from: socket.id});
    });

    socket.on("answer", ({answer, to}: {answer: RTCSessionDescriptionInit, to: string}) => {
        io.to(to).emit("answer", {answer, from: socket.id});
    })

    socket.on("peer:nego:needed", ({offer, targetChatToken}: {offer: RTCSessionDescriptionInit, targetChatToken: string}) => {
        io.to(targetChatToken).emit("peer:nego:needed", { offer, from: socket.id });
    });

    socket.on("peer:nego:done", ({answer, to}: {answer: RTCSessionDescriptionInit, to: string}) => {
        io.to(to).emit("peer:nego:final", {answer, to: socket.id});
    });

    socket.on("ice-candidate", ({candidate, to}: {candidate: RTCIceCandidate, to: string}) => {
        io.to(to).emit("ice-candidate", {candidate, sourceChatToken: socket.id});
    });

    socket.on("send:message", ({message, targetChatToken, isSecret, messageId}: {
        message: string, 
        targetChatToken: string, 
        isSecret?: boolean, 
        messageId?: string
    }) => {
        io.to(targetChatToken).emit("message:recieved", {
            message, 
            sourceChatToken: socket.id, 
            isSecret, 
            messageId
        });
    });

    socket.on("secret:mode:toggle", ({targetChatToken, enabled}: {targetChatToken: string, enabled: boolean}) => {
        io.to(targetChatToken).emit("secret:mode:changed", {enabled, sourceChatToken: socket.id});
    });

    socket.on("send:premium:status", ({isPremium, targetChatToken}: {isPremium: boolean, targetChatToken: string}) => {
        io.to(targetChatToken).emit("partner:premium:status", {isPremium, sourceChatToken: socket.id});
    });

    socket.on("stay:connected:request", ({targetChatToken, wantToStay}: {targetChatToken: string, wantToStay: boolean}) => {
        io.to(targetChatToken).emit("stay:connected:request", {wantToStay, from: socket.id});
    });

    socket.on("stay:connected:response", ({targetChatToken, wantToStay}: {targetChatToken: string, wantToStay: boolean}) => {
        io.to(targetChatToken).emit("stay:connected:response", {wantToStay, from: socket.id});
    });

    socket.on("skip", () => {
        const partnerId = userPairs[socket.id];

        if (partnerId) {
            io.to(partnerId).emit("skipped");
            delete userPairs[socket.id];
            delete userPairs[partnerId];

            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
                const partnerProfile = userProfiles[partnerId];
                if (partnerProfile) {
                    matchUser(partnerSocket, partnerProfile);
                }
            }
        }

        const currentProfile = userProfiles[socket.id];
        if (currentProfile) {
            matchUser(socket, currentProfile);
        }
    });

    socket.on("disconnect", () => {
        const partnerId = userPairs[socket.id];

        if(partnerId){
            io.to(partnerId).emit("partnerDisconnected");
            delete userPairs[socket.id];
            delete userPairs[partnerId];

            const partnerSocket = io.sockets.sockets.get(partnerId);
            if (partnerSocket) {
                const partnerProfile = userProfiles[partnerId];
                if (partnerProfile) {
                    matchUser(partnerSocket, partnerProfile);
                }
            }
        }

        waitingUsers = waitingUsers.filter(user => user.socketId !== socket.id);
        delete userProfiles[socket.id];
        
        console.log(`Socket disconnected ${socket.id}`);
    })
})

app.get('/', (req, res) => {
    res.send("Server is running...")
})

app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        connectedSockets: io.engine.clientsCount,
        waitingUsers: waitingUsers.length
    });
})

const PORT = process.env.PORT || 8000;

// Enhanced error handling for server startup
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`🌐 Health check available at http://localhost:${PORT}/health`);
    console.log(`🔌 Socket.IO server ready for connections`);
}).on('error', (err) => {
    console.error('❌ Server failed to start:', err);
    process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});