import express from "express";
import { Client } from "../models/Client.js";
import { Call } from "../models/Call.js";
import { logger } from "../utils/logger.js";

const router = express.Router();

// Get clients ready for calls
router.get("/for-calls", async (req, res) => {
  try {
    const {
      limit = 50,
      maxAttempts = 5,
      minDebtAmount = 0,
      hoursSinceLastCall = 24,
    } = req.query;

    const clients = await Client.find({
      status: "active",
      debt_amount: { $gte: parseInt(minDebtAmount) },
      call_attempts: { $lt: parseInt(maxAttempts) },
      $or: [
        { last_call_date: { $exists: false } },
        {
          last_call_date: {
            $lt: new Date(
              Date.now() - parseInt(hoursSinceLastCall) * 60 * 60 * 1000
            ),
          },
        },
      ],
    })
      .limit(parseInt(limit))
      .sort({ debt_amount: -1 });

    res.json({
      success: true,
      count: clients.length,
      clients: clients.map((c) => ({
        _id: c._id,
        name: c.name,
        phone: c.phone,
        debt_amount: c.debt_amount,
        contract_number: c.contract_number,
        call_attempts: c.call_attempts,
        last_call_date: c.last_call_date,
      })),
    });
  } catch (error) {
    logger.error("Get clients for calls error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get client details
router.get("/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await Client.findById(clientId);

    if (!client) {
      return res.status(404).json({
        success: false,
        error: "Client not found",
      });
    }

    // Get recent calls
    const recentCalls = await Call.find({ client_id: clientId })
      .sort({ start_time: -1 })
      .limit(10);

    res.json({
      success: true,
      client: {
        ...client.toObject(),
        recent_calls: recentCalls,
      },
    });
  } catch (error) {
    logger.error("Get client details error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Create new client
router.post("/", async (req, res) => {
  try {
    const { name, phone, debt_amount, contract_number } = req.body;

    // Check if client already exists
    const existingClient = await Client.findOne({ phone });
    if (existingClient) {
      return res.status(400).json({
        success: false,
        error: "Client with this phone number already exists",
      });
    }

    const client = new Client({
      name,
      phone,
      debt_amount,
      contract_number,
    });

    await client.save();

    res.status(201).json({
      success: true,
      message: "Client created successfully",
      client: {
        _id: client._id,
        name: client.name,
        phone: client.phone,
        debt_amount: client.debt_amount,
        contract_number: client.contract_number,
      },
    });
  } catch (error) {
    logger.error("Create client error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Update client
router.put("/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    const updates = req.body;

    const client = await Client.findByIdAndUpdate(
      clientId,
      { ...updates, updated_at: new Date() },
      { new: true }
    );

    if (!client) {
      return res.status(404).json({
        success: false,
        error: "Client not found",
      });
    }

    res.json({
      success: true,
      message: "Client updated successfully",
      client,
    });
  } catch (error) {
    logger.error("Update client error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get client statistics
router.get("/stats/overview", async (req, res) => {
  try {
    const stats = await Client.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalDebt: { $sum: "$debt_amount" },
          avgDebt: { $avg: "$debt_amount" },
        },
      },
    ]);

    const totalClients = await Client.countDocuments();
    const totalDebt = await Client.aggregate([
      { $group: { _id: null, total: { $sum: "$debt_amount" } } },
    ]);

    res.json({
      success: true,
      stats: {
        total_clients: totalClients,
        total_debt: totalDebt[0]?.total || 0,
        by_status: stats,
      },
    });
  } catch (error) {
    logger.error("Get client stats error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
