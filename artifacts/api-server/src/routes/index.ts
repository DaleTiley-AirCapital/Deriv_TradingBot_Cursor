import { Router, type IRouter } from "express";
import healthRouter from "./health";
import dataRouter from "./data";
import modelsRouter from "./models";
import backtestRouter from "./backtest";
import signalsRouter from "./signals";
import tradesRouter from "./trades";
import portfolioRouter from "./portfolio";
import riskRouter from "./risk";
import settingsRouter from "./settings";
import accountRouter from "./account";
import setupRouter from "./setup";
import aiChatRouter from "./aiChat";

const router: IRouter = Router();

router.use(healthRouter);
router.use(dataRouter);
router.use(modelsRouter);
router.use(backtestRouter);
router.use(signalsRouter);
router.use(tradesRouter);
router.use(portfolioRouter);
router.use(riskRouter);
router.use(settingsRouter);
router.use(accountRouter);
router.use(setupRouter);
router.use(aiChatRouter);

export default router;
