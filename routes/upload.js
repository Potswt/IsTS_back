import express from 'express';
import { protect } from '../auth/middleware.js';
import { upload } from '../utils/multer.js'; // ใช้เส้นทางสัมพันธ์
import path from 'path';


import dotenv from 'dotenv';
dotenv.config();



const router = express.Router();

// อัปโหลดไฟล์สำหรับแชท
router.post('/chat', protect, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    const fileUrl = `${process.env.API_BASE_URL}/uploads/chat/${req.file.filename}`;

    return res.status(200).json({
      message: 'File uploaded successfully',
      fileUrl,
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    return res.status(500).json({ message: 'Internal Server Error', error: error.message });
  }
});

export default router;
