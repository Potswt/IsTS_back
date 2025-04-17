import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/user.js';
import reportRoutes from './routes/report.js';
import uploadRoutes from './routes/upload.js';
import http from 'http';
import fs from 'fs';
import path from 'path';
import initializeSocket from './socket/socket.js';
import notificationRoutes from './routes/notification.js';
import jwt from 'jsonwebtoken';
import Report from './model/Report.js';
import Notification from './model/Notification.js';
import User from './model/User.js';
import Chat from './model/Chat.js';
import cron from 'node-cron';
import axios from 'axios';
import { createHmac } from 'crypto';


import { updateReportStatus } from './utils/reportUtils.js';
import cronRouter from './routes/cron.js'; // เปลี่ยนเส้นทางตามที่คุณต้องการ

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = initializeSocket(server);

app.use(cors({
  origin: [process.env.API_BASE_URL, 'http://localhost:5173', 'http://localhost:5500'],
}));
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// ตั้งค่าโฟลเดอร์สำหรับไฟล์แชท
const chatUploadDir = './uploads/chat';
if (!fs.existsSync(chatUploadDir)) {
  fs.mkdirSync(chatUploadDir, { recursive: true });
}

const port = process.env.PORT || 4000;

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/reports', reportRoutes(io));
app.use('/api/upload', uploadRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/', cronRouter);

// Channel Secret และ Access Token จาก LINE Developers Console
const CHANNEL_SECRET = process.env.CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.CHANNEL_ACCESS_TOKEN;

console.log('CHANNEL_SECRET:', CHANNEL_SECRET);
console.log('CHANNEL_ACCESS_TOKEN:', CHANNEL_ACCESS_TOKEN);

// ฟังก์ชันส่งข้อความผ่าน LINE Messaging API
const sendMessage = async (lineUserId, message) => {
  try {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      {
        to: lineUserId,
        messages: [{ type: 'text', text: message }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        },
      }
    );
    console.log('Message sent successfully to:', lineUserId);
  } catch (error) {
    console.error('Error sending message:', error.response?.data || error.message);
  }
};

// Webhook เพื่อรับข้อความจาก LINE
app.post('/webhook', async (req, res) => {
  console.log('Webhook received:', JSON.stringify(req.body, null, 2));
  console.log('Headers:', req.headers);

  // ตรวจสอบความถูกต้องของ request ด้วย signature
  const signature = req.headers['x-line-signature'];
  if (!signature) {
    console.error('Missing X-Line-Signature header');
    return res.status(200).json({ message: 'Webhook processed' });
  }

  const body = JSON.stringify(req.body);
  const hash = createHmac('SHA256', CHANNEL_SECRET).update(body).digest('base64');
  if (signature !== hash) {
    console.error('Invalid signature');
    return res.status(200).json({ message: 'Webhook processed' });
  }

  const events = req.body.events;
  for (const event of events) {
    if (event.type === 'message' && event.message.type === 'text') {
      const lineUserId = event.source.userId;
      const messageText = event.message.text.trim();

      console.log(`Message from ${lineUserId}: ${messageText}`);

      // ตรวจสอบว่าผู้ใช้ลงทะเบียนแล้วหรือยัง
      const user = await User.findOne({ lineUserId });

      if (messageText.toLowerCase() === 'ลงทะเบียน') {
        if (user) {
          await sendMessage(lineUserId, `คุณลงทะเบียนแล้วด้วยรหัสพนักงาน: ${user.employeeId}`);
        } else {
          await sendMessage(lineUserId, 'กรุณากรอกรหัสพนักงานของคุณ (เช่น EMP001) เพื่อลงทะเบียน');
        }
      } else if (!user) {
        // ถ้ายังไม่ได้ลงทะเบียน ให้ถือว่าข้อความที่ส่งมาเป็นรหัสพนักงาน
        const employeeId = messageText.trim();

        console.log('Searching for employeeId in User table:', employeeId);

        // ตรวจสอบว่ารหัสพนักงานถูกต้องในคอลเลกชัน User
        const existingUser = await User.findOne({ employeeId: { $regex: new RegExp(`^${employeeId}$`, 'i') } });
        if (!existingUser) {
          console.log('Employee ID not found in User table');
          await sendMessage(lineUserId, 'รหัสพนักงานไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง');
          return;
        }

        console.log('Employee ID found in User table:', existingUser);

        // ตรวจสอบว่ารหัสพนักงานนี้ถูกใช้ลงทะเบียน LINE แล้วหรือไม่
        const existingLink = await User.findOne({ employeeId, lineUserId: { $ne: null } });
        if (existingLink) {
          await sendMessage(lineUserId, 'รหัสพนักงานนี้ถูกใช้ลงทะเบียนแล้ว กรุณาติดต่อผู้ดูแลระบบ');
          return;
        }

        // อัปเดต lineUserId ใน User
        await User.updateOne(
          { employeeId },
          { $set: { lineUserId } }
        );
        await sendMessage(
          lineUserId,
          `ลงทะเบียนสำเร็จ! รหัสพนักงานของคุณคือ ${employeeId} คุณจะได้รับการแจ้งเตือนผ่าน LINE`
        );
      } else {
        await sendMessage(lineUserId, 'คุณลงทะเบียนแล้ว หากต้องการความช่วยเหลือเพิ่มเติม กรุณาติดต่อผู้ดูแลระบบ');
      }
    }
  }

  res.status(200).json({ message: 'Webhook processed' });
});

// API สำหรับส่งข้อความแจ้งเตือน
app.post('/notify-employee', async (req, res) => {
  const { employeeId, message } = req.body;

  if (!employeeId || !message) {
    return res.status(400).json({ message: 'Employee ID and message are required' });
  }

  const user = await User.findOne({ employeeId });
  if (!user || !user.lineUserId) {
    return res.status(404).json({ message: 'Employee not linked with LINE' });
  }

  await sendMessage(user.lineUserId, message);
  res.status(200).json({ message: 'Notification sent successfully' });
});

// API สำหรับทดสอบ
app.get('/api/v1/', (req, res) => {
  res.send('Hello World...');
});

// API สำหรับอัปเดตสถานะของรายงาน
app.put('/api/reports/:id/status', async (req, res) => {
  try {
    const { id: issueId } = req.params;
    const { status } = req.body;

    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userId = decoded.id;
    const role = decoded.role;

    const result = await updateReportStatus({ issueId, status, userId, role, io });
    res.status(200).json(result);
  } catch (error) {
    console.error('Error updating report status:', error.message);
    res.status(500).json({ message: error.message });
  }
});

// Cron Job สำหรับลบผู้ใช้ที่ลาออกหลังจาก 90 วัน
cron.schedule('0 0 * * *', async () => {
  console.log('Running cron job to delete inactive users...');

  try {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    const inactiveUsers = await User.find({
      status: 'inactive',
      inactiveAt: { $lte: ninetyDaysAgo },
    });

    for (const user of inactiveUsers) {
      const userId = user._id;

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // ลบไฟล์โปรไฟล์ (ถ้ามี)
        if (user.profileImage) {
          const fileName = user.profileImage.split('/').pop();
          const filePath = path.join(__dirname, 'uploads', 'profiles', fileName);
          try {
            if (fs.existsSync(filePath)) {
              await fs.promises.unlink(filePath);
            }
          } catch (fileError) {
            console.error(`Error deleting profile image for user ${userId}:`, fileError);
          }
        }

        // ลบไฟล์ในแชท (ถ้ามี)
        const chats = await Chat.find({ senderId: userId });
        for (const chat of chats) {
          if (chat.file) {
            const fileName = chat.file.split('/').pop();
            const filePath = path.join(__dirname, 'uploads', 'chat', fileName);
            try {
              if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
              }
            } catch (fileError) {
              console.error(`Error deleting chat file for user ${userId}:`, fileError);
            }
          }
        }

        // ลบข้อมูลที่เกี่ยวข้อง
        await Report.deleteMany({ userId }, { session });
        await Notification.deleteMany({ userId }, { session });
        await Chat.deleteMany({ senderId: userId }, { session });

        // ลบผู้ใช้
        await User.deleteOne({ _id: userId }, { session });

        await session.commitTransaction();
        console.log(`Deleted inactive user: ${user.firstName} ${user.lastName} (${userId})`);
      } catch (error) {
        await session.abortTransaction();
        console.error(`Error deleting inactive user ${userId}:`, error);
      } finally {
        session.endSession();
      }
    }

    console.log(`Cron job completed. Deleted ${inactiveUsers.length} inactive users.`);
  } catch (error) {
    console.error('Error in cron job:', error);
  }
});

app.locals.io = io;

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Connection Error:', err));

server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});

export { io };
