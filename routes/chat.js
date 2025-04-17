import express from 'express';
import mongoose from 'mongoose';
import Chat from '../model/Chat.js';
import Report from '../model/Report.js';
import Notification from '../model/Notification.js';
import { protect } from '../auth/middleware.js';
import upload from '../middleware/multerConfig.js';

import dotenv from 'dotenv';

dotenv.config();

const backendPort = process.env.API_BASE_URL || 5000; // ใช้พอร์ตที่คุณกำหนดใน .env
const router = express.Router();

// ส่งข้อความในแชท
router.post('/send/:issueId', protect, upload.single('file'), async (req, res) => {
  try {
    const issueId = req.params.issueId;
    const userId = req.user.id;
    const { message } = req.body;

    if (!mongoose.Types.ObjectId.isValid(issueId)) {
      return res.status(400).json({ message: 'Invalid issue ID' });
    }

    const report = await Report.findById(issueId).populate('userId assignedAdmin', 'firstName lastName role');
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    const isUser = report.userId._id.toString() === userId;
    const isAdmin = report.assignedAdmin?._id.toString() === userId;
    if (!isUser && !isAdmin && req.user.role !== 'SuperAdmin') {
      return res.status(403).json({ message: 'You are not authorized to send messages in this chat' });
    }

    if (report.status === 'completed') {
      return res.status(400).json({ message: 'Cannot send messages in a completed report' });
    }

    if (!message && !req.file) {
      return res.status(400).json({ message: 'Message or file is required' });
    }

    let fileUrl = null;
    if (req.file) {
      fileUrl = `${process.env.API_BASE_URL}/uploads/chats/${req.file.filename}`;
    }

    const chatMessage = new Chat({
      issueId,
      senderId: userId,
      message: message || '',
      file: fileUrl,
      fileName: req.file ? req.file.originalname : null,
  
      createdAt: new Date(),
    });
    await chatMessage.save();

    const populatedChatMessage = await Chat.findById(chatMessage._id).populate('senderId', 'firstName lastName role profileImage');

    const io = req.app.locals.io;
    io.to(`chat:${issueId}`).emit('newChatMessage', {
      id: populatedChatMessage._id,
      issueId,
      senderId: populatedChatMessage.senderId._id,
      sender: {
        firstName: populatedChatMessage.senderId.firstName,
        lastName: populatedChatMessage.senderId.lastName,
        role: populatedChatMessage.senderId.role,
        profileImage: populatedChatMessage.senderId.profileImage,
      },
      message: populatedChatMessage.message,
      file: populatedChatMessage.file,
      createdAt: populatedChatMessage.createdAt,
    });

    const recipientId = isUser ? report.assignedAdmin?._id?.toString() : report.userId._id.toString();
    if (recipientId && mongoose.Types.ObjectId.isValid(recipientId)) {
      try {
        const notification = new Notification({
          userId: new mongoose.Types.ObjectId(recipientId),
          issueId,
          message: `New message in report ${report.topic || issueId}: ${message || 'File received'}`,
          type: 'chat',
          isRead: false,
          createdAt: new Date(),
        });
        await notification.save();

        io.to(recipientId).emit('statusUpdate', {
          id: notification._id,
          issueId,
          userId: recipientId,
          message: notification.message,
          type: notification.type,
          isRead: notification.isRead,
          createdAt: notification.createdAt,
        });
      } catch (error) {
        console.error('Error creating chat notification:', error.message);
      }
    }

    return res.status(200).json({
      message: 'Message sent successfully',
      data: {
        id: populatedChatMessage._id,
        issueId,
        profileImage: populatedChatMessage.senderId.profileImage,
        senderId: populatedChatMessage.senderId._id,
        message: populatedChatMessage.message,
        file: populatedChatMessage.file,
        createdAt: populatedChatMessage.createdAt,
      },
    });
  } catch (error) {
    console.error('Error sending chat message:', error.message);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

// ดึงข้อความในแชท
router.get('/:issueId', protect, async (req, res) => {
  try {
    const issueId = req.params.issueId;
    const userId = req.user.id;

    if (!mongoose.Types.ObjectId.isValid(issueId)) {
      return res.status(400).json({ message: 'Invalid issue ID' });
    }

    const report = await Report.findById(issueId);
    if (!report) {
      return res.status(404).json({ message: 'Report not found' });
    }

    const isUser = report.userId.toString() === userId;
    const isAdmin = report.assignedAdmin?.toString() === userId;
    if (!isUser && !isAdmin && req.user.role !== 'SuperAdmin') {
      return res.status(403).json({ message: 'You are not authorized to view this chat' });
    }

    const chats = await Chat.find({ issueId })
      .populate('senderId', 'firstName lastName role profileImage')
      .sort({ createdAt: 1 });

    return res.status(200).json({
      message: 'Chat messages retrieved successfully',
      data: chats,
    });
  } catch (error) {
    console.error('Error retrieving chat messages:', error.message);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

export default router;
